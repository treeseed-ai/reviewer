import { describe, expect, it } from 'vitest';
import { assertLocalFixtureOrigin } from '../../src/verifiers/browser-scene-fixtures.ts';

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
});
