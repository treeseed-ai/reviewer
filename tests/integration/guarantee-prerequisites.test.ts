import { afterEach, expect, it } from 'vitest';
import { appendFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { planLocalGuarantees, runLocalGuarantees } from '../../src/verifiers/guarantees/command.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(failing = false, skipped = false) {
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
		expect(spawnSync('git', args, { cwd: root }).status).toBe(0);
	}
	return root;
}

it('runs every owning unit and integration assertion before any scene and repeats suites for a fresh invocation', () => {
	const root = fixture(); const plan = planLocalGuarantees(root, ['proof']);
	for (const runId of ['first', 'second']) expect(runLocalGuarantees(root, plan, runId).ok).toBe(true);
	const order = readFileSync(resolve(root, '.treeseed/order'), 'utf8').trim().split('\n');
	expect(order).toHaveLength(6);
	for (const start of [0, 3]) {
		expect(order.slice(start, start + 2).sort()).toEqual(['integration', 'unit']);
		expect(order[start + 2]).toBe('scene');
	}
});

it('blocks native scene side effects when an unselected unit test fails', () => {
	const root = fixture(true); const report = runLocalGuarantees(root, planLocalGuarantees(root, ['proof']), 'unit-red');
	expect(report.ok).toBe(false);
	expect(readFileSync(resolve(root, '.treeseed/order'), 'utf8')).not.toContain('scene');
	expect(report.diagnostics.map(item => item.message).join(' ')).toContain('prerequisite');
});

it('blocks acceptance when the complete integration suite contains a skipped assertion', () => {
	const root = fixture(false, true); const report = runLocalGuarantees(root, planLocalGuarantees(root, ['proof']), 'integration-skipped');
	expect(report.ok).toBe(false);
	expect(readFileSync(resolve(root, '.treeseed/order'), 'utf8')).not.toContain('scene');
});

it('does not execute prerequisites while planning and rejects a missing full test entrypoint before scenes', () => {
	const root = fixture(); const plan = planLocalGuarantees(root, ['proof']);
	expect(plan.ok).toBe(true); expect(existsSync(resolve(root, '.treeseed/order'))).toBe(false);
	writeFileSync(resolve(root, 'package.json'), JSON.stringify({ type: 'module', scripts: {} }));
	expect(runLocalGuarantees(root, plan, 'missing-suite').ok).toBe(false);
	expect(existsSync(resolve(root, '.treeseed/order'))).toBe(false);
});

it('rejects empty suites and filtered test entrypoints before native scene execution', () => {
	for (const mode of ['empty','filtered','unsupported']) {
		const root = fixture();
		if (mode === 'empty') writeFileSync(resolve(root,'vitest.config.ts'),'export default {test:{include:["missing/**/*.test.ts"]}};');
		else writeFileSync(resolve(root,'package.json'),JSON.stringify({scripts:{test:mode === 'filtered' ? 'vitest run tests/unit.test.ts' : 'node --test'}}));
		expect(runLocalGuarantees(root,planLocalGuarantees(root,['proof']),mode).ok).toBe(false);
		expect(existsSync(resolve(root,'.treeseed/order'))).toBe(false);
	}
});

it('rejects a candidate mutation performed by a passing full suite and retains exact prerequisite custody', () => {
	const root = fixture();
	appendFileSync(resolve(root,'tests/unit.test.ts'),"\nimport {writeFileSync} from 'node:fs'; it('hidden candidate mutation',()=>{writeFileSync('candidate.ts','changed');});");
	const report = runLocalGuarantees(root,planLocalGuarantees(root,['proof']),'mutation');
	expect(report.ok).toBe(false);
	expect(readFileSync(resolve(root,'.treeseed/order'),'utf8')).not.toContain('scene');
	const receipt = JSON.parse(readFileSync(resolve(root,'.treeseed/guarantees/runs/mutation',report.results[0]!.evidence[0]!), 'utf8'));
	expect(receipt).toMatchObject({passed:false,exitCode:0,checks:{total:3,passed:3,failed:0}});
	expect(receipt.commit).toMatch(/^[a-f0-9]{40}$/u); expect(receipt.sourceDigest).toMatch(/^[a-f0-9]{64}$/u);
});

it('deduplicates prerequisite suites across dependent guarantees only within the same invocation', () => {
	const root = fixture();
	writeFileSync(resolve(root,'guarantees/downstream.guarantee.yaml'),'id: downstream\ndependencies: {guarantees: [proof]}\napi: {verifierRefs: [proof.scene]}\n');
	const report = runLocalGuarantees(root,planLocalGuarantees(root,['downstream']),'dependency');
	expect(report.ok).toBe(true);
	expect(readFileSync(resolve(root,'.treeseed/order'),'utf8').trim().split('\n').sort()).toEqual(['integration','scene','unit']);
	expect(report.results[0]!.evidence.at(-1)).toEqual(report.results[1]!.evidence.at(-1));
});

it('blocks every scene when a different participating owner has failing prerequisites', () => {
	const good = fixture(), bad = fixture(true);
	const plan = planLocalGuarantees(good,['proof']);
	plan.verifiers['other.scene'] = {...plan.verifiers['proof.scene']!, root:bad};
	plan.entries.push({...plan.entries[0]!,id:'other',verifierRefs:['other.scene']});
	const report = runLocalGuarantees(good,plan,'two-owners');
	expect(report.ok).toBe(false); expect(report.counts.blocked).toBe(2);
	for (const root of [good,bad]) expect(readFileSync(resolve(root,'.treeseed/order'),'utf8')).not.toContain('scene');
});

it('rejects an escaped test config and missing Git custody without scene side effects', () => {
	for (const mode of ['escaped','missing-git']) {
		const root = fixture();
		if (mode === 'missing-git') rmSync(resolve(root,'.git'),{recursive:true,force:true});
		else { const other = fixture(); symlinkSync(resolve(other,'vitest.config.ts'),resolve(root,'outside.config.ts'));
			writeFileSync(resolve(root,'package.json'),JSON.stringify({scripts:{test:'vitest run --config outside.config.ts'}})); }
		expect(runLocalGuarantees(root,planLocalGuarantees(root,['proof']),mode).ok).toBe(false);
		expect(existsSync(resolve(root,'.treeseed/order'))).toBe(false);
	}
});
