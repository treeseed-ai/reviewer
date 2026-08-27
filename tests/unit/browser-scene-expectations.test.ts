import { describe, expect, it, vi } from 'vitest';
import { runExpectations } from '../../src/verifiers/browser-scene-expectations.ts';

describe('browser scene URL expectations', () => {
  it('accepts an already-current matching URL without waiting for another load event', async () => {
    const waitForURL = vi.fn();
    const runtime = { page: { url: () => 'https://admin.treeseed.localhost/auth/confirm-email?token=redacted', waitForURL } } as any;

    await runExpectations(runtime, { urlIncludes: '/auth/confirm-email' });

    expect(waitForURL).not.toHaveBeenCalled();
  });

  it('polls current location without coupling the assertion to a navigation lifecycle', async () => {
    const waitForURL = vi.fn();
    const url = vi.fn()
      .mockReturnValueOnce('https://admin.treeseed.localhost/auth/check-email')
      .mockReturnValue('https://admin.treeseed.localhost/auth/confirm-email?token=redacted');
    const runtime = { page: { url, waitForURL } } as any;

    await runExpectations(runtime, { urlIncludes: '/auth/confirm-email' });

    expect(url).toHaveBeenCalledTimes(3);
    expect(waitForURL).not.toHaveBeenCalled();
  });
});
