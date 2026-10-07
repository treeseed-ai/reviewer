import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect } from 'vitest';

// Same native fixture; callers retain ownership of every allocated root and cleanup.
export const roots: string[] = [];
export function fixture(failing = false, skipped = false) {
	const root = mkdtempSync(resolve(tmpdir(), 'guarantee-full-suite-')); roots.push(root);
	for (const directory of ['tests', 'guarantees', '.treeseed', 'node_modules']) mkdirSync(resolve(root, directory), { recursive: true });
	symlinkSync(resolve(import.meta.dirname, '../../node_modules/vitest'), resolve(root, 'node_modules/vitest'));
	writeFileSync(resolve(root, 'package.json'), JSON.stringify({ type: 'module', scripts: { test: 'vitest run --config vitest.config.ts' } }));
	writeFileSync(resolve(root, 'vitest.config.ts'), 'export default {test:{include:["tests/**/*.test.ts"]}};');
	writeFileSync(resolve(root, '.gitignore'), 'node_modules\n.treeseed\n');
	writeFileSync(resolve(root, 'tests/unit.test.ts'), `import {it,expect} from 'vitest'; import {appendFileSync} from 'node:fs'; it('unit boundary',()=>{appendFileSync('.treeseed/order','unit\\n');expect(${failing}).toBe(false);});`);
	writeFileSync(resolve(root, 'tests/integration.test.ts'), `import {it,expect} from 'vitest'; import {appendFileSync} from 'node:fs'; it${skipped ? '.skip' : ''}('integration boundary',()=>{appendFileSync('.treeseed/order','integration\\n');expect(1).toBe(1);});`);
	writeFileSync(resolve(root, 'scene.ts'), "import test from 'node:test'; import {appendFileSync} from 'node:fs'; test('scene boundary',()=>{appendFileSync('.treeseed/order','scene\\n');});");
	writeFileSync(resolve(root, 'guarantees/proof.guarantee.yaml'), 'id: proof\napi: {verifierRefs: [proof.scene]}\n');
	writeFileSync(resolve(root, 'guarantees/proof.verifiers.yaml'), 'verifiers:\n  proof.scene: {kind: nodeTestCase, ownerPackage: fixture, testFile: scene.ts, testName: scene boundary}\n');
	for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Exact test candidate']]) {
		const stage=args.includes('commit')?'COMMIT':args[0]!.toUpperCase();
		expect(spawnSync('git', args, { cwd: root }).status,`ACCEPTANCE_PREREQUISITE_GIT_${stage}: exact fixture Git stage`).toBe(0);
	}
	return root;
}
