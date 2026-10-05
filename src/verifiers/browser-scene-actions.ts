import { confirmLatest } from './browser-scene-mailpit.ts';
import { interpolate, locator } from './browser-scene-runtime.ts';
import type { SceneRuntime, SceneSelector } from './browser-scene-types.ts';

async function fill(runtime: SceneRuntime, raw: any) {
  const target = locator(runtime.page, raw as SceneSelector);
  await target.waitFor({ state: 'attached', timeout: 15_000 });
  if (raw.internal === true && !await target.isVisible()) {
    await target.evaluate((element, value) => {
      if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) throw new Error('Internal fill requires an input or textarea.');
      element.value = String(value);
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    }, String(raw.value ?? ''));
    return;
  }
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

async function createBrowserSession(runtime: SceneRuntime, raw: any) {
  const browser = runtime.context.browser();
  if (!browser) throw new Error('The browser session runtime is unavailable.');
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    userAgent: String(raw.userAgent ?? 'TreeSeed Guarantee Additional Session'),
    extraHTTPHeaders: raw.clientIp ? { 'x-forwarded-for': String(raw.clientIp) } : {},
  });
  try {
    const page = await context.newPage();
    await page.goto(new URL('/auth/sign-in', runtime.adminOrigin).toString(), { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.getByRole('textbox', { name: 'Email or username' }).fill(String(raw.identifier));
    await page.locator('input[name="password"]').fill(String(raw.password));
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL((url) => url.pathname.startsWith('/app'), { timeout: 15_000 });
  } finally {
    await context.close();
  }
}

async function settleEnhancedSubmission(target: ReturnType<typeof locator>) {
  await target.evaluate((element) => {
    const form = element instanceof HTMLButtonElement || element instanceof HTMLInputElement ? element.form : element.closest('form');
    if (!form || form.dataset.tsSubmit !== 'enhanced') return;
    return new Promise<void>((resolve) => {
      const started = Date.now();
      const timer = setInterval(() => {
        if (!form.isConnected || !form.hasAttribute('aria-busy') || Date.now() - started >= 15_000) {
          clearInterval(timer);
          resolve();
        }
      }, 10);
    });
  }).catch(() => undefined);
}

async function clickAndSettle(runtime: SceneRuntime, target: ReturnType<typeof locator>) {
  const submission = await target.evaluate((element) => {
    const form = element instanceof HTMLButtonElement || element instanceof HTMLInputElement ? element.form : element.closest('form');
    if (!form) return 'none';
    return form.dataset.tsSubmit === 'enhanced' ? 'enhanced' : 'regular';
  }).catch(() => 'none');
  if (submission === 'regular') {
    const navigation = runtime.page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => undefined);
    await target.click({ timeout: 15_000 });
    await navigation;
    return;
  }
  await target.click({ timeout: 15_000 });
  if (submission === 'enhanced') await settleEnhancedSubmission(target);
}

export async function runAction(runtime: SceneRuntime, source: Record<string, unknown>) {
  const action = interpolate(source, runtime) as Record<string, any>;
  if (action.goto !== undefined) {
    const route = typeof action.goto === 'string' ? action.goto : action.goto.path;
    await runtime.page.goto(new URL(route, runtime.adminOrigin).toString(), { waitUntil: 'domcontentloaded', timeout: 45_000 });
  } else if (action.click) {
    await runtime.page.waitForLoadState('load', { timeout: 45_000 });
    const target = locator(runtime.page, action.click);
    if (action.click.revealWith && !await target.isVisible()) {
      const reveal = locator(runtime.page, action.click.revealWith);
      if (await reveal.isVisible()) await reveal.click({ timeout: 15_000 });
    }
    await target.waitFor({ state: 'visible', timeout: 15_000 });
    await clickAndSettle(runtime, target);
  } else if (action.clickVisibleSequence) {
    await runtime.page.waitForLoadState('load', { timeout: 45_000 });
    for (const selector of action.clickVisibleSequence) {
      const target = locator(runtime.page, selector);
      await target.waitFor({ state: 'visible', timeout: 15_000 });
      await clickAndSettle(runtime, target);
    }
  } else if (action.fill) await fill(runtime, action.fill);
  else if (action.select) {
    const target = locator(runtime.page, action.select);
    await target.waitFor({ state: 'attached', timeout: 15_000 });
    const navigation = action.select.settleNavigation === true
      ? runtime.page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => undefined)
      : Promise.resolve();
    await target.selectOption(action.select.value ?? { label: action.select.label }, { timeout: 15_000 });
    await navigation;
  } else if (action.keyboard) await runtime.page.keyboard.press(String(action.keyboard));
  else if (action.pause?.mode === 'timed') await new Promise((done) => setTimeout(done, Math.min(Number(action.pause.durationSeconds ?? 0), 5) * 1000));
  else if (action.apiRequest) await apiRequest(runtime, action.apiRequest);
  else if (action.createBrowserSession) await createBrowserSession(runtime, action.createBrowserSession);
  else if (action.mailpitConfirmLatest) await confirmLatest(runtime, action.mailpitConfirmLatest);
  else throw new Error(`Unsupported scene action: ${Object.keys(action).join(', ') || 'empty'}.`);
}
