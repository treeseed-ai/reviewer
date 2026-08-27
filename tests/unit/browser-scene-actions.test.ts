import { describe, expect, it, vi } from 'vitest';
import { runAction } from '../../src/verifiers/browser-scene-actions.ts';
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
    const target = { waitFor: vi.fn(), click: vi.fn() };
    const page = {
      waitForLoadState: vi.fn(),
      getByRole: vi.fn().mockReturnValue({ first: () => target }),
    };

    await runAction({ page } as any, { click: { role: 'button', name: 'Leave team' } });

    expect(page.waitForLoadState).toHaveBeenCalledWith('load', { timeout: 45_000 });
    expect(target.click).toHaveBeenCalledWith({ timeout: 15_000 });
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
