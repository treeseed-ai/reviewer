import { confirmLatest } from './browser-scene-mailpit.ts';
import { interpolate, locator } from './browser-scene-runtime.ts';
import type { SceneRuntime, SceneSelector } from './browser-scene-types.ts';

async function fill(runtime: SceneRuntime, raw: any) {
  const target = locator(runtime.page, raw as SceneSelector);
  await target.waitFor({ state: 'attached', timeout: 15_000 });
  await target.fill(String(raw.value ?? ''), { timeout: 15_000 });
}

async function apiRequest(runtime: SceneRuntime, raw: any) {
  const origin = raw.base === 'web' ? runtime.adminOrigin : runtime.apiOrigin;
  const headers = Object.fromEntries(Object.entries(raw.headers ?? {}).map(([key, value]) => [key, String(value)]));
  const body = raw.body === undefined ? undefined : JSON.stringify(raw.body);
  if (body && !Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')) headers['content-type'] = 'application/json';
  const response = await fetch(new URL(String(raw.path), `${origin.replace(/\/+$/u, '')}/`), { method: String(raw.method ?? 'GET'), headers, body, redirect: 'manual' });
  const expected = Number(raw.expectedStatus ?? 200);
  if (response.status !== expected) throw new Error(`Scene API request expected HTTP ${expected}, received ${response.status}.`);
}

export async function runAction(runtime: SceneRuntime, source: Record<string, unknown>) {
  const action = interpolate(source, runtime) as Record<string, any>;
  if (action.goto !== undefined) {
    const route = typeof action.goto === 'string' ? action.goto : action.goto.path;
    await runtime.page.goto(new URL(route, runtime.adminOrigin).toString(), { waitUntil: 'domcontentloaded', timeout: 45_000 });
  } else if (action.click) {
    const target = locator(runtime.page, action.click);
    await target.waitFor({ state: 'visible', timeout: 15_000 }); await target.click({ timeout: 15_000 });
  } else if (action.clickVisibleSequence) {
    for (const selector of action.clickVisibleSequence) {
      const target = locator(runtime.page, selector);
      await target.waitFor({ state: 'visible', timeout: 15_000 }); await target.click({ timeout: 15_000 });
    }
  } else if (action.fill) await fill(runtime, action.fill);
  else if (action.select) {
    const target = locator(runtime.page, action.select);
    await target.waitFor({ state: 'attached', timeout: 15_000 });
    await target.selectOption(action.select.value ?? { label: action.select.label }, { timeout: 15_000 });
  } else if (action.keyboard) await runtime.page.keyboard.press(String(action.keyboard));
  else if (action.pause?.mode === 'timed') await new Promise((done) => setTimeout(done, Math.min(Number(action.pause.durationSeconds ?? 0), 5) * 1000));
  else if (action.apiRequest) await apiRequest(runtime, action.apiRequest);
  else if (action.mailpitConfirmLatest) await confirmLatest(runtime, action.mailpitConfirmLatest);
  else throw new Error(`Unsupported scene action: ${Object.keys(action).join(', ') || 'empty'}.`);
}
