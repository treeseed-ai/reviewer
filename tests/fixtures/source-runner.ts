import { cpSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect } from 'vitest';
import { fixture } from './guarantee-prerequisites.ts';

/** Actual source CLI modules in a declared Git fixture with its own complete
 * native suites. This proves runner custody, not real portfolio installation. */
export function sourceRunnerFixture() {
	const repository = resolve(import.meta.dirname, '../..'), root = fixture();
	rmSync(resolve(root, 'node_modules'), { recursive: true });
	symlinkSync(resolve(repository, 'node_modules'), resolve(root, 'node_modules'));
	for (const path of ['package.json', 'treeseed.package.yaml'])
		writeFileSync(resolve(root, path), readFileSync(resolve(repository, path)));
	cpSync(resolve(repository, 'src/verifiers/guarantees'), resolve(root, 'src/verifiers/guarantees'), { recursive: true });
	const commit = spawnSync('git', ['add', '.'], { cwd: root }); expect(commit.status).toBe(0);
	expect(spawnSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Exact source runner fixture'], { cwd: root }).status).toBe(0);
	return root;
}
