import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { localRequestDiagnostics, planLocalGuarantees, runLocalGuarantees } from '../../src/verifiers/guarantees/command.ts';

const roots: string[] = [];
function fixture() {
	const root = mkdtempSync(resolve(tmpdir(), 'treeseed-guarantee-tests-'));
	roots.push(root);
	mkdirSync(resolve(root, 'guarantees/verifiers'), { recursive: true });
	mkdirSync(resolve(root, 'tests'), { recursive: true });
	mkdirSync(resolve(root, 'node_modules/vitest'), { recursive: true });
	writeFileSync(resolve(root, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }));
	writeFileSync(resolve(root, 'tests/proof.test.ts'), 'A bound test source.');
	writeFileSync(resolve(root, 'guarantees/proof.guarantee.yaml'), 'id: proof\napi:\n  verifierRefs: [proof.check]\n');
	writeFileSync(resolve(root, 'guarantees/verifiers/proof.verifiers.yaml'),
		'verifiers:\n  proof.check:\n    kind: vitestCase\n    ownerPackage: fixture\n    testFile: tests/proof.test.ts\n    testName: proves the boundary\n');
	return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
describe('package-owned guarantee execution', () => {
	it('cannot turn a component check into live outcome or activation proof', () => {
		const root = fixture();
		for (const requirement of ['proof: { requiredCommands: [workdays.show] }', 'outcomes: [{ id: live }]', 'activation: { minimumConsecutivePasses: 3 }']) {
			writeFileSync(resolve(root, 'guarantees/proof.guarantee.yaml'), `id: proof\napi: { verifierRefs: [proof.check] }\n${requirement}\n`);
			expect(planLocalGuarantees(root, ['proof']).diagnostics.map(d => d.message)).toContain('proof: Live outcome/activation requirements cannot be attested by local component tests.');
		}
	});
	it('does not silently ignore unsupported browser, recording, filtering, or environment requests', () => {
		for (const option of ['--device', '--record', '--types', '--no-dependencies', '--evidence-target'])
			expect(localRequestDiagnostics([option]).length).toBeGreaterThan(0);
		expect(localRequestDiagnostics(['--environment', 'production']).length).toBeGreaterThan(0);
		expect(localRequestDiagnostics(['--environment', 'local', '--ids', 'proof', '--plan'])).toEqual([]);
	});
	it('rejects an empty selection and missing contracts', () => {
		const root = fixture();
		expect(planLocalGuarantees(root, []).ok).toBe(false);
		expect(planLocalGuarantees(root, ['absent']).diagnostics.map(d => d.message)).toContain('Missing guarantee absent.');
	});
	it('rejects missing verifier implementations and required scenes instead of reporting a scaffold pass', () => {
		const root = fixture();
		rmSync(resolve(root, 'tests/proof.test.ts'));
		expect(planLocalGuarantees(root, ['proof']).ok).toBe(false);
		writeFileSync(resolve(root, 'tests/proof.test.ts'), 'source');
		writeFileSync(resolve(root, 'guarantees/proof.guarantee.yaml'), 'id: proof\nscene: { required: true }\napi: { verifierRefs: [proof.check] }');
		expect(planLocalGuarantees(root, ['proof']).diagnostics.map(d => d.message)).toContain('proof: Required scene manifest is missing.');
	});
	it('requires executable scene steps, not empty or demo-only placeholders', () => {
		const root = fixture();
		writeFileSync(resolve(root, 'guarantees/proof.guarantee.yaml'), 'id: proof\nscene: { required: true, manifest: scenario.yaml }');
		for (const workflow of [[], [{ id: 'one', demoOnly: true, action: { verifier: 'proof.check' }, expect: { status: 'passed' } }]]) {
			writeFileSync(resolve(root, 'scenario.yaml'), JSON.stringify({ workflow }));
			expect(planLocalGuarantees(root, ['proof']).ok).toBe(false);
		}
		writeFileSync(resolve(root, 'scenario.yaml'), JSON.stringify({ workflow: [{ id: 'one', action: { verifier: 'proof.check' }, expect: { status: 'passed' } }] }));
		expect(planLocalGuarantees(root, ['proof']).ok).toBe(true);
	});
	it('rejects uncovered required sections and negative cases before execution', () => {
		const root = fixture();
		for (const section of ['api', 'content', 'audit']) {
			writeFileSync(resolve(root, 'guarantees/proof.guarantee.yaml'), `id: proof\n${section}: { required: true, verifierRefs: [] }\n`);
			expect(planLocalGuarantees(root, ['proof']).ok).toBe(false);
		}
		writeFileSync(resolve(root, 'guarantees/proof.guarantee.yaml'), 'id: proof\napi: { verifierRefs: [proof.check] }\nnegativeCases: [{ id: denied, verifierRefs: [] }]\n');
		expect(planLocalGuarantees(root, ['proof']).ok).toBe(false);
	});
	it('rejects unsafe run identifiers before creating evidence', () => {
		const root = fixture();
		for (const id of ['.', '..', '../escape', '/absolute'])
			expect(() => runLocalGuarantees(root, planLocalGuarantees(root, ['proof']), id)).toThrow('Unsafe');
	});
	it('rejects ambiguous selected bindings without coupling a run to unrelated catalog entries', () => {
		const root = fixture();
		writeFileSync(resolve(root, 'guarantees/verifiers/duplicate.verifiers.yaml'), 'verifiers:\n  unrelated: { kind: vitestCase }\n');
		writeFileSync(resolve(root, 'guarantees/verifiers/other.verifiers.yaml'), 'verifiers:\n  unrelated: { kind: vitestCase }\n');
		expect(planLocalGuarantees(root, ['proof']).ok).toBe(true);
		writeFileSync(resolve(root, 'guarantees/verifiers/duplicate.verifiers.yaml'), 'verifiers:\n  proof.check: { kind: vitestCase }\n');
		expect(planLocalGuarantees(root, ['proof']).diagnostics.map(d => d.message)).toContain('Duplicate verifier proof.check.');
	});
	it.each(['passed', 'skipped', 'missing', 'failed'])('executes the native Node test boundary without accepting %s as a fabricated pass', status => {
		const root = fixture();
		symlinkSync(resolve(import.meta.dirname, '../../node_modules/tsx'), resolve(root, 'node_modules/tsx'), 'dir');
		writeFileSync(resolve(root, 'guarantees/verifiers/proof.verifiers.yaml'),
			'verifiers:\n  proof.check:\n    kind: nodeTestCase\n    ownerPackage: fixture\n    testFile: tests/node.test.ts\n    testName: proves the boundary\n');
		const name = status === 'missing' ? 'another case' : 'proves the boundary';
		writeFileSync(resolve(root, 'tests/node.test.ts'), `import test from 'node:test';\ntest(${JSON.stringify(name)}, {skip:${status === 'skipped'}}, () => {${status === 'failed' ? "throw new Error('synthetic failure');" : ''}});`);
		const report = runLocalGuarantees(root, planLocalGuarantees(root, ['proof']), 'node-regression');
		expect(report.ok).toBe(status === 'passed');
	});
	it.each([
		{ success: true, numPassedTests: 0, numFailedTests: 0 },
		{ success: false, numPassedTests: 1, numFailedTests: 1 },
		{ success: true, numPassedTests: 1, numFailedTests: 0, testResults: [{ assertionResults: [{ title: 'wrong boundary', status: 'passed' }] }] },
		{ success: true, numPassedTests: 1, numFailedTests: 0, testResults: [{ assertionResults: [{ title: 'proves the boundary', status: 'skipped' }] }] },
		{ success: true, numPassedTests: 1, numFailedTests: 0, testResults: [{ assertionResults: [{ title: 'proves the boundary', status: 'passed' }] }] },
		{ success: 'true', numPassedTests: '1', numFailedTests: 0, testResults: [{ assertionResults: [{ title: 'proves the boundary', status: 'passed' }] }] },
		{},
	])('fails closed on zero tests, failed checks and malformed result contracts: %j', result => {
		const root = fixture();
		writeFileSync(resolve(root, 'node_modules/vitest/vitest.mjs'), `process.stdout.write(${JSON.stringify(JSON.stringify(result))});`);
		const report = runLocalGuarantees(root, planLocalGuarantees(root, ['proof']), 'regression');
		expect(report.ok).toBe(false);
		expect(report.counts.failed).toBe(1);
	});
	it('records component scope and immutable receipts without claiming live golden acceptance', () => {
		const root = fixture();
		writeFileSync(resolve(root, 'node_modules/vitest/vitest.mjs'), 'process.stdout.write(JSON.stringify({success:true,numPassedTests:1,numFailedTests:0,testResults:[{assertionResults:[{title:"proves the boundary",status:"passed",duration:1}]}]}));');
		const report = runLocalGuarantees(root, planLocalGuarantees(root, ['proof']), 'regression');
		expect(report.ok).toBe(true);
		expect(report.scope).toBe('local-component-tests');
		expect(report.results[0]?.evidence).toHaveLength(1);
		expect(() => runLocalGuarantees(root, planLocalGuarantees(root, ['proof']), 'regression')).toThrow('immutable');
	});
	it('blocks the whole run on unresolved dependencies', () => {
		const root = fixture();
		writeFileSync(resolve(root, 'guarantees/proof.guarantee.yaml'), 'id: proof\ndependencies: { guarantees: [absent] }\napi: { verifierRefs: [proof.check] }');
		const report = runLocalGuarantees(root, planLocalGuarantees(root, ['proof']), 'regression');
		expect(report.ok).toBe(false);
		expect(report.counts.blocked).toBe(1);
	});
	it('rejects dependency cycles rather than silently treating a visited node as satisfied', () => {
		const root = fixture();
		writeFileSync(resolve(root, 'guarantees/proof.guarantee.yaml'), 'id: proof\ndependencies: { guarantees: [proof] }\napi: { verifierRefs: [proof.check] }');
		expect(planLocalGuarantees(root, ['proof']).diagnostics.map(d => d.message)).toContain('Cyclic guarantee dependency proof.');
	});
	it('executes prerequisite guarantees first and blocks downstream checks after their failure', () => {
		const root = fixture();
		writeFileSync(resolve(root, 'guarantees/downstream.guarantee.yaml'), 'id: downstream\ndependencies: { guarantees: [proof] }\napi: { verifierRefs: [proof.check] }');
		const plan = planLocalGuarantees(root, ['downstream']);
		expect(plan.entries.map(entry => entry.id)).toEqual(['proof', 'downstream']);
		writeFileSync(resolve(root, 'node_modules/vitest/vitest.mjs'), 'process.stdout.write(JSON.stringify({success:false,numPassedTests:0,numFailedTests:1,testResults:[]}));');
		const report = runLocalGuarantees(root, plan, 'regression');
		expect(report.results.map(result => result.status)).toEqual(['failed', 'blocked']);
		expect(report.ok).toBe(false);
	});
});
