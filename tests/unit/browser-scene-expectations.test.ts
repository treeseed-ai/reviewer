import { describe, expect, it, vi } from 'vitest';
import { runExpectations } from '../../src/verifiers/browser-scene-expectations.ts';

describe('browser scene URL expectations', () => {
  it('accepts an already-current matching URL without waiting for another load event', async () => {
    const waitForURL = vi.fn();
    const runtime = { page: { url: () => 'https://admin.treeseed.localhost/auth/confirm-email?token=redacted', waitForURL } } as any;

    await runExpectations(runtime, { urlIncludes: '/auth/confirm-email' });

    expect(waitForURL).not.toHaveBeenCalled();
  });

  it('waits through DOMContentLoaded when the expected URL is not current yet', async () => {
    const waitForURL = vi.fn().mockResolvedValue(undefined);
    const runtime = { page: { url: () => 'https://admin.treeseed.localhost/auth/check-email', waitForURL } } as any;

    await runExpectations(runtime, { urlIncludes: '/auth/confirm-email' });

    expect(waitForURL).toHaveBeenCalledWith(expect.any(Function), { timeout: 15_000, waitUntil: 'domcontentloaded' });
  });
});
