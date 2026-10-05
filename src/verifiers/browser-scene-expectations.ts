import { interpolate, locator } from './browser-scene-runtime.ts';
import type { SceneRuntime, SceneSelector } from './browser-scene-types.ts';

function values(value: unknown) {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

async function visible(runtime: SceneRuntime, selector: SceneSelector, expected: boolean) {
  const target = locator(runtime.page, selector);
  if (expected) await target.waitFor({ state: 'visible', timeout: 15_000 });
  else {
    try { await target.waitFor({ state: 'hidden', timeout: 5_000 }); }
    catch { if (await target.isVisible()) throw new Error(`Expected ${JSON.stringify(selector)} to be hidden.`); }
  }
}

async function text(runtime: SceneRuntime, value: string, expected: boolean) {
  const target = runtime.page.getByText(value, { exact: false }).first();
  if (expected) await target.waitFor({ state: 'visible', timeout: 15_000 });
  else {
    try { await target.waitFor({ state: 'hidden', timeout: 5_000 }); }
    catch { if (await target.isVisible()) throw new Error(`Expected text to be absent: ${value}.`); }
  }
}

export async function runExpectations(runtime: SceneRuntime, source: Record<string, unknown>) {
  const expect = interpolate(source, runtime) as Record<string, any>;
  if (expect.urlIncludes) {
    const fragment = String(expect.urlIncludes);
    const deadline = Date.now() + 15_000;
    while (!runtime.page.url().includes(fragment) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 50));
    if (!runtime.page.url().includes(fragment)) throw new Error(`Expected browser URL to include ${fragment}; received ${runtime.page.url()}.`);
  }
  for (const value of values(expect.text)) await text(runtime, String(value), true);
  for (const value of values(expect.notText)) await text(runtime, String(value), false);
  for (const selector of values(expect.visible)) await visible(runtime, selector as SceneSelector, true);
  for (const selector of values(expect.notVisible)) await visible(runtime, selector as SceneSelector, false);
  for (const selector of values(expect.focused)) {
    const target = locator(runtime.page, selector as SceneSelector);
    if (!await target.evaluate((element) => element === element.ownerDocument.activeElement)) throw new Error(`Expected ${JSON.stringify(selector)} to be focused.`);
  }
}
