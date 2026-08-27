import { describe, expect, it, vi } from 'vitest';
import { runAction } from '../../src/verifiers/browser-scene-actions.ts';
import { browserDeviceProfile, browserDeviceProfileMatrix, browserDeviceProfiles } from '../../src/verifiers/browser-scene-executor.ts';
import { consumeExpectedClientErrors, ignoredConsoleSource } from '../../src/verifiers/browser-scene-executor.ts';

describe('browser scene internal fields', () => {
  it('sets attached internal fields without using a visibility-gated fill', async () => {
    const target = { waitFor: vi.fn(), isVisible: vi.fn().mockResolvedValue(false), evaluate: vi.fn(), fill: vi.fn() };
    const page = { locator: vi.fn().mockReturnValue({ first: () => target }) };

    await runAction({ page } as any, { fill: { css: 'input[type="hidden"]', internal: true, value: 'stale-v1' } });

    expect(target.waitFor).toHaveBeenCalledWith({ state: 'attached', timeout: 15_000 });
    expect(target.evaluate).toHaveBeenCalledWith(expect.any(Function), 'stale-v1');
    expect(target.fill).not.toHaveBeenCalled();
  });

	it('uses user-like fill semantics for visible fields selected internally', async () => {
		const target = { waitFor: vi.fn(), isVisible: vi.fn().mockResolvedValue(true), evaluate: vi.fn(), fill: vi.fn() };
		const page = { locator: vi.fn().mockReturnValue({ first: () => target }) };
		await runAction({ page } as any, { fill: { css: 'input[type="password"]', internal: true, value: 'correct-password' } });
		expect(target.fill).toHaveBeenCalledWith('correct-password', { timeout: 15_000 });
		expect(target.evaluate).not.toHaveBeenCalled();
	});
});

describe('browser scene click readiness', () => {
  it('waits for enhancement scripts at the load boundary before clicking', async () => {
    const target = { waitFor: vi.fn(), click: vi.fn(), evaluate: vi.fn().mockResolvedValueOnce('enhanced').mockResolvedValueOnce(undefined) };
    const page = {
      waitForLoadState: vi.fn(),
      getByRole: vi.fn().mockReturnValue({ first: () => target }),
    };

    await runAction({ page } as any, { click: { role: 'button', name: 'Leave team' } });

    expect(page.waitForLoadState).toHaveBeenCalledWith('load', { timeout: 45_000 });
    expect(target.click).toHaveBeenCalledWith({ timeout: 15_000 });
    expect(target.evaluate).toHaveBeenCalledTimes(2);
  });

  it('waits for a regular server form navigation before returning', async () => {
    let finishNavigation!: () => void;
    const navigation = new Promise<void>((resolve) => { finishNavigation = resolve; });
    const target = { waitFor: vi.fn(), click: vi.fn(async () => finishNavigation()), evaluate: vi.fn().mockResolvedValue('regular') };
    const page = { waitForLoadState: vi.fn(), waitForNavigation: vi.fn().mockReturnValue(navigation), getByRole: vi.fn().mockReturnValue({ first: () => target }) };

    await runAction({ page } as any, { click: { role: 'button', name: 'Approve' } });

    expect(page.waitForNavigation).toHaveBeenCalledWith({ waitUntil: 'domcontentloaded', timeout: 15_000 });
    expect(target.click).toHaveBeenCalledWith({ timeout: 15_000 });
  });

  it('opens a declared responsive shell before clicking its hidden target', async () => {
    const target = { isVisible: vi.fn().mockResolvedValue(false), waitFor: vi.fn(), click: vi.fn(), evaluate: vi.fn().mockResolvedValue('none') };
    const reveal = { isVisible: vi.fn().mockResolvedValue(true), click: vi.fn() };
    const page = { waitForLoadState: vi.fn(), getByRole: vi.fn((_role, { name }) => ({ first: () => name === 'Sign out' ? target : reveal })) };

    await runAction({ page } as any, { click: { role: 'button', name: 'Sign out', revealWith: { role: 'button', name: 'Open team operations' } } });

    expect(reveal.click).toHaveBeenCalledWith({ timeout: 15_000 });
    expect(target.waitFor).toHaveBeenCalledWith({ state: 'visible', timeout: 15_000 });
  });
});

describe('browser scene select readiness', () => {
  it('settles an explicitly declared navigation caused by selection', async () => {
    let finishNavigation!: () => void;
    const navigation = new Promise<void>((resolve) => { finishNavigation = resolve; });
    const target = { waitFor: vi.fn(), selectOption: vi.fn(async () => finishNavigation()) };
    const page = { waitForNavigation: vi.fn().mockReturnValue(navigation), getByRole: vi.fn().mockReturnValue({ first: () => target }) };

    await runAction({ page } as any, { select: { role: 'combobox', name: 'Color scheme', label: 'Personal theme', settleNavigation: true } });

    expect(page.waitForNavigation).toHaveBeenCalledWith({ waitUntil: 'domcontentloaded', timeout: 15_000 });
    expect(target.selectOption).toHaveBeenCalledWith({ label: 'Personal theme' }, { timeout: 15_000 });
  });
});

describe('browser device profiles', () => {
  it('uses the declared Admin viewport and rejects unknown profiles', () => {
    expect(browserDeviceProfiles.tablet_chromium).toEqual({ viewport: { width: 820, height: 1180 }, isMobile: true, hasTouch: true });
    expect(browserDeviceProfiles.mobile_chromium.viewport).toEqual({ width: 390, height: 844 });
    expect(browserDeviceProfile('desktop_chromium')).toBe('desktop_chromium');
    expect(() => browserDeviceProfile('desktop_chromium_typo')).toThrow(/Unsupported browser device profile/u);
		expect(browserDeviceProfileMatrix()).toEqual(['desktop_chromium', 'tablet_chromium', 'mobile_chromium']);
		expect(browserDeviceProfileMatrix('mobile_chromium,desktop_chromium')).toEqual(['mobile_chromium', 'desktop_chromium']);
		expect(() => browserDeviceProfileMatrix('desktop_chromium,desktop_chromium')).toThrow(/duplicates/u);
  });
});

describe('optional browser resources', () => {
  it('allows only favicon and optional knowledge page console sources', () => {
    expect(ignoredConsoleSource('https://admin.treeseed.localhost/v1/knowledge/pages/account.identity')).toBe(true);
    expect(ignoredConsoleSource('https://admin.treeseed.localhost/favicon.svg')).toBe(true);
    expect(ignoredConsoleSource('https://admin.treeseed.localhost/v1/auth/web/preferences')).toBe(false);
    expect(ignoredConsoleSource('not a URL')).toBe(false);
  });

  it('consumes only source-scoped errors added by an expected negative step', () => {
    const errors = ['existing', '/app/teams/one/edit: Failed to load resource', '/v1/auth/web/preferences: Failed to load resource'];
    consumeExpectedClientErrors(errors, 1, '/edit');
    expect(errors).toEqual(['existing', '/v1/auth/web/preferences: Failed to load resource']);
  });
});
