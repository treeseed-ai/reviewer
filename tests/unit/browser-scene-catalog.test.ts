import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { loadActiveIdentityTeamScenes } from '../../src/verifiers/browser-scene-catalog.ts';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function write(root: string, path: string, body: string) {
  const target = resolve(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, body);
}

describe('browser scene catalog', () => {
  it('loads active identity scenes in dependency order and records blocked-scene edges', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'reviewer-scenes-'));
    roots.push(root);
    const guarantees = [
      {
        sourcePath: 'guarantees/user/auth/register.guarantee.yaml',
        manifest: {
          id: 'user.auth.register', type: 'user', status: 'active',
          dependencies: { guarantees: [] },
          scene: { required: true, executionKey: 'admin.identity.register', manifest: 'register.scene.yaml' },
        },
      },
      {
        sourcePath: 'guarantees/team/create.guarantee.yaml',
        manifest: {
          id: 'team.create', type: 'team', status: 'active',
          dependencies: { guarantees: ['user.auth.register'] },
          scene: { required: true, executionKey: 'admin.team.create', manifest: 'create.scene.yaml' },
        },
      },
      {
        sourcePath: 'guarantees/user/planned.guarantee.yaml',
        manifest: {
          id: 'user.auth.planned', type: 'user', status: 'planned',
          scene: { required: true, executionKey: 'admin.identity.planned', manifest: 'planned.scene.yaml' },
        },
      },
    ];
    write(root, 'dist/standards/guarantee-catalog.json', `${JSON.stringify({ guarantees })}\n`);
    write(root, 'guarantees/user/auth/register.scene.yaml', 'id: register\nworkflow: []\n');
    write(root, 'guarantees/team/create.scene.yaml', 'id: create-team\nworkflow: []\n');

    const scenes = loadActiveIdentityTeamScenes(root);

    expect([...scenes.keys()]).toEqual(['admin.identity.register', 'admin.team.create']);
    expect(scenes.get('admin.team.create')?.dependsOn).toEqual(['admin.identity.register']);
  });
});
