import { describe, expect, it, vi } from 'vitest';
import { runAction } from '../../src/verifiers/browser-scene-actions.ts';
import { consumeExpectedClientErrors, ignoredConsoleSource } from '../../src/verifiers/browser-scene-executor.ts';

describe('browser scene internal fields', () => {
  it('sets attached internal fields without using a visibility-gated fill', async () => {
    const target = { waitFor: vi.fn(), evaluate: vi.fn(), fill: vi.fn() };
    const page = { locator: vi.fn().mockReturnValue({ first: () => target }) };

    await runAction({ page } as any, { fill: { css: 'input[type="hidden"]', internal: true, value: 'stale-v1' } });

    expect(target.waitFor).toHaveBeenCalledWith({ state: 'attached', timeout: 15_000 });
    expect(target.evaluate).toHaveBeenCalledWith(expect.any(Function), 'stale-v1');
    expect(target.fill).not.toHaveBeenCalled();
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
