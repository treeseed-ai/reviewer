import { describe, expect, it } from 'vitest';
import { blockedCleanupSceneCases, browserRunShort } from '../../src/verifiers/browser-scene-executor.js';
import type { SceneCase, SceneCheck } from '../../src/verifiers/browser-scene-types.js';

describe('browser scene run identity', () => {
  it('derives a bounded unique identity from the complete correlated run id', () => {
    const first = browserRunShort('generation75-desktop-desktop-chromium');
    const second = browserRunShort('generation76-desktop-desktop-chromium');
    expect(first).toMatch(/^[a-f0-9]{12}$/u);
    expect(second).toMatch(/^[a-f0-9]{12}$/u);
    expect(first).not.toBe(second);
  });

  it('selects blocked destructive scenes for best-effort residue cleanup', () => {
    const cleanup = { executionKey: 'account.delete', scenePath: 'delete.yaml', guaranteeIds: ['guarantee.account.delete'], dependsOn: ['account.appearance'], scene: {
      id: 'delete-account', journey: { producesState: [{ key: 'account.deleted' }] }, workflow: [],
    } } satisfies SceneCase;
    const ordinary = { ...cleanup, executionKey: 'account.logout', scene: { id: 'logout', journey: { producesState: [{ key: 'auth.logged-out' }] }, workflow: [] } } satisfies SceneCase;
    const checks = [
      { id: 'account.appearance', status: 'failed', durationMs: 1 },
      { id: 'account.delete', status: 'blocked', durationMs: 0 },
      { id: 'account.logout', status: 'blocked', durationMs: 0 },
    ] satisfies SceneCheck[];
    expect(blockedCleanupSceneCases(new Map([[cleanup.executionKey, cleanup], [ordinary.executionKey, ordinary]]), checks)).toEqual([cleanup]);
  });
});
