import { existsSync, mkdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { runAction } from './browser-scene-actions.ts';
import { runExpectations } from './browser-scene-expectations.ts';
import { redactedError, screenshotPath } from './browser-scene-runtime.ts';
import { sanitizeBrowserTrace } from './browser-trace-redaction.ts';
import type { SceneCase, SceneCheck, SceneRuntime } from './browser-scene-types.ts';

function browserExecutable(explicit?: string) {
  const candidates = [explicit, process.env.TREESEED_CHROMIUM_EXECUTABLE, '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/usr/bin/chromium'];
  const found = candidates.find((entry): entry is string => Boolean(entry && existsSync(entry)));
  if (!found) throw new Error('A local Chromium executable is required for Reviewer browser evidence.');
  return found;
}

export function ignoredConsoleSource(source: string) {
  if (!source) return false;
  try {
    const path = new URL(source).pathname;
    return ['/favicon.ico', '/favicon.svg'].includes(path) || path.startsWith('/v1/knowledge/pages/');
  } catch {
    return false;
  }
}

export function consumeExpectedClientErrors(errors: string[], start: number, sourcePathIncludes?: string) {
  if (!sourcePathIncludes) return;
  const retained = errors.slice(start).filter((entry) => !entry.startsWith('/') || !entry.split(':', 1)[0]!.includes(sourcePathIncludes));
  errors.splice(start, errors.length - start, ...retained);
}

async function ensureAuthentication(sceneCase: SceneCase, runtime: SceneRuntime) {
  const auth = sceneCase.scene.setup?.auth;
  if (auth?.role === 'anonymous') { await runtime.context.clearCookies(); return; }
  if (auth?.required !== true) {
    if (sceneCase.executionKey === 'admin.identity.password-reset') await runtime.context.clearCookies();
    return;
  }
  await runtime.page.goto(new URL('/app/', runtime.adminOrigin).toString(), { waitUntil: 'domcontentloaded', timeout: 45_000 });
  if (!runtime.page.url().includes('/auth/sign-in')) return;
  await runtime.page.getByRole('textbox', { name: 'Email or username' }).fill(`guarantee-${runtime.runId}-${runtime.deviceId}@treeseed.local`);
  await runtime.page.locator('input[name="password"]').fill('TreeSeedGuaranteeReset123!');
  await runtime.page.getByRole('button', { name: 'Sign in' }).click();
	await runtime.page.waitForURL((url) => url.pathname === '/auth/authorize', { timeout: 15_000 });
	await runtime.page.getByRole('textbox', { name: 'Email or username' }).fill(`guarantee-${runtime.runId}-${runtime.deviceId}@treeseed.local`);
	await runtime.page.locator('input[name="password"]').fill('TreeSeedGuaranteeReset123!');
	await runtime.page.getByRole('button', { name: 'Approve' }).click();
  await runtime.page.waitForURL((url) => url.pathname.startsWith('/app'), { timeout: 15_000 });
}

async function executeScene(sceneCase: SceneCase, runtime: SceneRuntime): Promise<SceneCheck> {
  const started = Date.now(), evidence: string[] = [];
  const consoleStart = runtime.consoleErrors.length, requestStart = runtime.requestErrors.length;
  try {
    await ensureAuthentication(sceneCase, runtime);
    for (const step of sceneCase.scene.workflow ?? []) {
      const stepConsoleStart = runtime.consoleErrors.length;
      await runAction(runtime, step.action ?? {});
      await runExpectations(runtime, step.expect ?? {});
      consumeExpectedClientErrors(runtime.consoleErrors, stepConsoleStart, step.expect?.clientErrorSourceIncludes);
      const path = screenshotPath(runtime, sceneCase.scene.id, step.id);
      await runtime.page.screenshot({ path, fullPage: true }); evidence.push(path);
    }
    const clientFailures = [...runtime.consoleErrors.slice(consoleStart), ...runtime.requestErrors.slice(requestStart)];
    if (clientFailures.length) throw new Error(`Browser emitted ${clientFailures.length} unexpected error(s): ${clientFailures.slice(0, 3).join('; ')}`);
    return { id: sceneCase.executionKey, status: 'passed', durationMs: Date.now() - started, evidence };
  } catch (error) {
    const path = screenshotPath(runtime, sceneCase.scene.id, 'failure');
    await runtime.page.screenshot({ path, fullPage: true }).catch(() => undefined); evidence.push(path);
    return { id: sceneCase.executionKey, status: 'failed', durationMs: Date.now() - started, error: redactedError(error), evidence };
  }
}

export async function executeBrowserScenes(input: {
  scenes: Map<string, SceneCase>;
  adminOrigin: string;
  apiOrigin: string;
  mailpitOrigin: string;
  evidenceRoot: string;
  runId: string;
  executablePath?: string;
}) {
  mkdirSync(input.evidenceRoot, { recursive: true });
  const browser = await chromium.launch({ executablePath: browserExecutable(input.executablePath), headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, ignoreHTTPSErrors: true });
  const page = await context.newPage(), consoleErrors: string[] = [], requestErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const source = message.location().url;
    if (ignoredConsoleSource(source)) return;
    const path = source ? new URL(source).pathname : '';
    consoleErrors.push(`${path ? `${path}: ` : ''}${redactedError(message.text())}`);
  });
  page.on('pageerror', (error) => consoleErrors.push(redactedError(error)));
  page.on('requestfailed', (request) => {
    const failure = request.failure()?.errorText ?? 'failed';
    const path = new URL(request.url()).pathname;
    if (failure.includes('ERR_ABORTED') || ['/favicon.ico', '/favicon.svg'].includes(path)) return;
    requestErrors.push(`${request.method()} ${path}: ${failure}`);
  });
  page.on('response', (response) => { if (response.status() >= 500) requestErrors.push(`${response.request().method()} ${new URL(response.url()).pathname}: HTTP ${response.status()}`); });
  const tracePath = resolve(input.evidenceRoot, 'trace.zip');
  await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
  const runtime: SceneRuntime = { ...input, runShort: input.runId.replace(/[^a-z0-9]/giu, '').slice(-10), deviceId: 'desktop-chromium', page, context, consoleErrors, requestErrors };
  const checks: SceneCheck[] = [];
  try {
    for (const sceneCase of input.scenes.values()) {
      const blockers = sceneCase.dependsOn.filter((dependency) => checks.some((check) => check.id === dependency && check.status !== 'passed'));
      if (blockers.length) {
        checks.push({
          id: sceneCase.executionKey,
          status: 'blocked',
          durationMs: 0,
          error: `Prerequisite browser scene(s) did not pass: ${blockers.join(', ')}.`,
          evidence: [],
        });
        continue;
      }
      checks.push(await executeScene(sceneCase, runtime));
    }
  } finally {
    await context.tracing.stop({ path: tracePath }).catch(() => undefined);
    await context.close().catch(() => undefined); await browser.close().catch(() => undefined);
  }
  sanitizeBrowserTrace(tracePath);
  for (const check of checks) {
    check.evidence?.push(tracePath);
    check.evidence = check.evidence?.map((path) => relative(input.evidenceRoot, path));
  }
  return checks;
}
