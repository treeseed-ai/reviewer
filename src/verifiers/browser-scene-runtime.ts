import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Locator, Page } from 'playwright-core';
import type { SceneRuntime, SceneSelector } from './browser-scene-types.ts';

export function interpolate(value: unknown, runtime: SceneRuntime): any {
  if (typeof value === 'string') return value
    .replaceAll('{{runId}}', runtime.runId)
    .replaceAll('{{runShort}}', runtime.runShort)
    .replaceAll('{{deviceId}}', runtime.deviceId);
  if (Array.isArray(value)) return value.map((entry) => interpolate(entry, runtime));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, interpolate(entry, runtime)]));
  return value;
}

export function locator(page: Page, selector: SceneSelector): Locator {
  if (selector.css) return page.locator(selector.css).first();
  if (selector.scene) return page.locator(`[data-scene="${selector.scene.replaceAll('"', '\\"')}"]`).first();
  if (selector.testId) return page.getByTestId(selector.testId).first();
  if (selector.role) return page.getByRole(selector.role as any, selector.name ? { name: selector.name } : undefined).first();
  throw new Error(`Unsupported scene selector ${JSON.stringify(selector)}.`);
}

export function safeName(value: string) {
  return value.replace(/[^A-Za-z0-9_.-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 100) || 'evidence';
}

export function screenshotPath(runtime: SceneRuntime, sceneId: string, stepId: string) {
  const directory = resolve(runtime.evidenceRoot, 'screenshots', safeName(sceneId));
  mkdirSync(directory, { recursive: true });
  return resolve(directory, `${safeName(stepId)}.png`);
}

export function redactedError(error: unknown) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/giu, 'Bearer [REDACTED]')
    .replace(/(?:confirm|reset)_[A-Za-z0-9_-]+/gu, '[REDACTED]')
    .replace(/(password|token|secret)(["'=:\s]+)[^\s"']+/giu, '$1$2[REDACTED]');
}
