import { describe, expect, it } from 'vitest';
import { assertLocalFixtureOrigin, fetchFixtureRequest } from '../../src/verifiers/browser-scene-fixtures.ts';

describe('browser scene fixtures', () => {
  it.each([
    'https://api.treeseed.localhost',
    'http://localhost:8787',
    'http://127.0.0.1:8787',
    'http://api:8787',
  ])('permits the local development origin %s', (origin) => {
    expect(() => assertLocalFixtureOrigin(origin, 'API origin')).not.toThrow();
  });

  it.each([
    'https://api.treeseed.example',
    'https://treeseed.ai',
    'file:///tmp/api',
  ])('rejects the non-local origin %s', (origin) => {
    expect(() => assertLocalFixtureOrigin(origin, 'API origin')).toThrow(/local development origin/u);
  });

  it('reports the fixture operation, safe URL, and nested network cause', async () => {
    const networkError = new Error('fetch failed', { cause: new Error('unable to verify the first certificate') });
    const fetcher = async () => { throw networkError; };

    await expect(fetchFixtureRequest(
      new URL('https://api.treeseed.localhost/v1/auth/web/sign-up?token=secret'),
      { method: 'POST', body: '{"password":"secret"}' },
      fetcher as typeof fetch,
    )).rejects.toThrow(
      'Browser fixture POST https://api.treeseed.localhost/v1/auth/web/sign-up failed: fetch failed caused by unable to verify the first certificate',
    );
  });
});
