import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { localRequestDiagnostics, planLocalGuarantees, runLocalGuarantees, verifierTimeout } from '../../src/verifiers/guarantees/command.ts';

const roots: string[] = [];
const fullSuiteReport = {success:true,numTotalTests:2,numPassedTests:2,numFailedTests:0,numPendingTests:0,numTodoTests:0,
	numFailedTestSuites:0,numPendingTestSuites:0,testResults:[{assertionResults:[
		{title:'unit prerequisite',status:'passed',duration:1},{title:'integration prerequisite',status:'passed',duration:1}]}]};
const caseProgram = (source: string) => `if(!process.argv.includes('-t')){
	const destination=process.argv.find(value=>value.startsWith('--outputFile='))?.slice('--outputFile='.length);
	if(!destination)throw new Error('Unit fixture requires the native prerequisite report destination.');
	(await import('node:fs')).writeFileSync(destination,${JSON.stringify(JSON.stringify(fullSuiteReport))});
}else{${source}}`;
function fixture() {
	const root = mkdtempSync(resolve(tmpdir(), 'treeseed-guarantee-tests-'));
	roots.push(root);
	mkdirSync(resolve(root, 'guarantees/verifiers'), { recursive: true });
	mkdirSync(resolve(root, 'tests'), { recursive: true });
	mkdirSync(resolve(root, 'node_modules/vitest'), { recursive: true });
	writeFileSync(resolve(root, 'node_modules/vitest/vitest.mjs'), caseProgram(''));
	writeFileSync(resolve(root, '.gitignore'), 'node_modules\n.treeseed\n');
	writeFileSync(resolve(root, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }));
	writeFileSync(resolve(root, 'treeseed.package.yaml'), JSON.stringify({development:{project:{id:'fixture'},targets:[{id:'runtime',dependencies:[]}]}}));
	writeFileSync(resolve(root, 'tests/proof.test.ts'), 'A bound test source.');
	writeFileSync(resolve(root, 'guarantees/proof.guarantee.yaml'), 'id: proof\napi:\n  verifierRefs: [proof.check]\n');
	writeFileSync(resolve(root, 'guarantees/verifiers/proof.verifiers.yaml'),
		'verifiers:\n  proof.check:\n    kind: vitestCase\n    ownerPackage: fixture\n    testFile: tests/proof.test.ts\n    testName: proves the boundary\n');
	for (const args of [['init','-q'],['add','.'],['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','Fixture candidate']])
		expect(spawnSync('git', args, {cwd:root}).status).toBe(0);
	return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
describe('package-owned guarantee execution', () => {
	it('keeps a bounded package-declared test watchdog distinct from assignment clocks', () => {
		expect(verifierTimeout(undefined)).toBe(120_000);
		expect(verifierTimeout(28_800_000)).toBe(28_800_000);
		expect(verifierTimeout(86_400_000)).toBe(86_400_000);
		for (const value of [null, '120000', 0, -1, 1.5, Number.NaN, Infinity, 86_400_001])
			expect(() => verifierTimeout(value)).toThrow('timeoutMs');
	});
	it('rejects malformed verifier timeouts before any test execution', () => {
		const root = fixture();
		writeFileSync(resolve(root, 'guarantees/verifiers/proof.verifiers.yaml'),
			'verifiers:\n  proof.check: { kind: nodeTestCase, ownerPackage: fixture, testFile: tests/proof.test.ts, testName: proves the boundary, timeoutMs: 0 }\n');
		expect(planLocalGuarantees(root, ['proof']).ok).toBe(false);
	});
	it('records the timeout boundary and fails closed on a killed verifier', () => {
		const root = fixture();
		writeFileSync(resolve(root, 'guarantees/verifiers/proof.verifiers.yaml'),
			'verifiers:\n  proof.check: { kind: nodeTestCase, ownerPackage: fixture, testFile: tests/proof.test.ts, testName: proves the boundary, timeoutMs: 1 }\n');
		const report = runLocalGuarantees(root, planLocalGuarantees(root, ['proof']), 'bounded-watchdog');
		expect(report.ok).toBe(false);
		const evidence = JSON.parse(readFileSync(resolve(root, '.treeseed/guarantees/runs/bounded-watchdog', report.results[0]!.evidence[0]!), 'utf8'));
		expect(evidence).toMatchObject({ passed: false, timeoutMs: 1, processErrorCode: 'ETIMEDOUT' });
	});
	it('runs a native scene with its declared watchdog and retains that exact budget in evidence', () => {
		const root = fixture();
		writeFileSync(resolve(root, 'guarantees/verifiers/proof.verifiers.yaml'),
			'verifiers:\n  proof.check: { kind: nodeTestCase, ownerPackage: fixture, testFile: tests/proof.test.ts, testName: proves the boundary, timeoutMs: 5000 }\n');
		writeFileSync(resolve(root, 'tests/proof.test.ts'), "import test from 'node:test';\ntest('proves the boundary', async () => { await new Promise(resolve => setTimeout(resolve, 20)); });\n");
		const report = runLocalGuarantees(root, planLocalGuarantees(root, ['proof']), 'declared-watchdog');
		expect(report.ok).toBe(true);
		const evidence = JSON.parse(readFileSync(resolve(root, '.treeseed/guarantees/runs/declared-watchdog', report.results[0]!.evidence[0]!), 'utf8'));
		expect(evidence).toMatchObject({ passed: true, timeoutMs: 5000, processErrorCode: null });
	});
	it('rejects unknown scope and component verifiers masquerading as integrated runtime evidence', () => {
		const root = fixture();
		writeFileSync(resolve(root, 'guarantees/proof.guarantee.yaml'), 'id: proof\nscene: { required: true, manifest: scenario.yaml }\n');
		for (const scope of ['production', 'local-integrated-runtime']) {
			writeFileSync(resolve(root, 'scenario.yaml'), JSON.stringify({ scope, workflow: [{ id: 'readback', action: { verifier: 'proof.check' }, expect: { status: 'passed' } }] }));
			expect(planLocalGuarantees(root, ['proof']).ok).toBe(false);
		}
	});
	it('rejects mixed component and integrated evidence in one receipt', () => {
		const root = fixture();
		writeFileSync(resolve(root, 'guarantees/live.guarantee.yaml'), 'id: live\nscene: { required: true, manifest: live.yaml }\n');
		writeFileSync(resolve(root, 'live.yaml'), JSON.stringify({ scope: 'local-integrated-runtime', workflow: [{ id: 'readback', action: { verifier: 'live.check' }, expect: { status: 'passed' } }] }));
		writeFileSync(resolve(root, 'guarantees/verifiers/live.verifiers.yaml'), 'verifiers:\n  live.check: { kind: nodeTestCase, ownerPackage: fixture, testFile: tests/proof.test.ts, testName: live readback }\n');
		expect(planLocalGuarantees(root, ['proof', 'live']).diagnostics.map(d => d.message)).toContain('Component and integrated runtime evidence must run separately.');
	});
	it('retains integrated scope only for an explicitly executed native acceptance test', () => {
		const root = fixture();
		writeFileSync(resolve(root, 'guarantees/proof.guarantee.yaml'), 'id: proof\nscene: { required: true, manifest: scenario.yaml }\n');
		writeFileSync(resolve(root, 'scenario.yaml'), JSON.stringify({ scope: 'local-integrated-runtime', workflow: [{ id: 'readback', action: { verifier: 'proof.check' }, expect: { status: 'passed' } }] }));
		writeFileSync(resolve(root, 'guarantees/verifiers/proof.verifiers.yaml'), 'verifiers:\n  proof.check: { kind: nodeTestCase, ownerPackage: fixture, testFile: tests/proof.test.ts, testName: live readback }\n');
		writeFileSync(resolve(root, 'tests/proof.test.ts'), "import test from 'node:test';\ntest('live readback', () => {});\n");
		const report = runLocalGuarantees(root, planLocalGuarantees(root, ['proof']), 'live-scope');
		expect(report.ok).toBe(true);
		expect(report.scope).toBe('local-integrated-runtime');
	});
	it('blocks later scene steps after a failed smoke check without executing the campaign', () => {
		const root = fixture();
		symlinkSync(resolve(import.meta.dirname, '../../node_modules/tsx'), resolve(root, 'node_modules/tsx'), 'dir');
		writeFileSync(resolve(root, 'guarantees/proof.guarantee.yaml'), 'id: proof\nscene: { required: true, manifest: scenario.yaml }\n');
		writeFileSync(resolve(root, 'scenario.yaml'), JSON.stringify({ scope: 'local-integrated-runtime', workflow: [
			{ id: 'smoke', action: { verifier: 'proof.smoke' }, expect: { status: 'passed' } },
			{ id: 'campaign', action: { verifier: 'proof.campaign' }, expect: { status: 'passed' } },
		] }));
		writeFileSync(resolve(root, 'guarantees/verifiers/proof.verifiers.yaml'), 'verifiers:\n  proof.smoke: { kind: nodeTestCase, ownerPackage: fixture, testFile: tests/proof.test.ts, testName: smoke }\n  proof.campaign: { kind: nodeTestCase, ownerPackage: fixture, testFile: tests/proof.test.ts, testName: campaign }\n');
		writeFileSync(resolve(root, 'tests/proof.test.ts'), "import test from 'node:test';\nimport { writeFileSync } from 'node:fs';\ntest('smoke', () => { throw new Error('smoke failed'); });\ntest('campaign', () => { writeFileSync('campaign-ran', 'yes'); });\n");
		const report = runLocalGuarantees(root, planLocalGuarantees(root, ['proof']), 'scene-fail-fast');
		expect(report.ok).toBe(false);
		expect(report.results[0]?.steps.map(step => step.status)).toEqual(['failed', 'blocked']);
		expect(report.results[0]?.steps[1]?.evidence).toEqual([]);
		expect(() => readFileSync(resolve(root, 'campaign-ran'))).toThrow();
	});
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
	it('retains a native criterion failure code without copying secret-bearing messages', () => {
		const root = fixture();
		writeFileSync(resolve(root, 'guarantees/verifiers/proof.verifiers.yaml'), 'verifiers:\n  proof.check: { kind: nodeTestCase, ownerPackage: fixture, testFile: tests/proof.test.ts, testName: proves the boundary }\n');
		writeFileSync(resolve(root, 'tests/proof.test.ts'), "import test from 'node:test';\ntest('proves the boundary', () => {throw new Error('ACCEPTANCE_PLANNING_CYCLES: secret-must-not-leak');});\n");
		const report = runLocalGuarantees(root, planLocalGuarantees(root, ['proof']), 'safe-native-diagnostic');
		expect(report.ok).toBe(false);
		const path = resolve(root, '.treeseed/guarantees/runs/safe-native-diagnostic', report.results[0]!.evidence[0]!);
		const evidence = readFileSync(path, 'utf8');
		expect(evidence).toContain('ACCEPTANCE_PLANNING_CYCLES');
		expect(evidence).not.toContain('secret-must-not-leak');
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
		writeFileSync(resolve(root, 'node_modules/vitest/vitest.mjs'), caseProgram(`process.stdout.write(${JSON.stringify(JSON.stringify(result))});`));
		const report = runLocalGuarantees(root, planLocalGuarantees(root, ['proof']), 'regression');
		expect(report.ok).toBe(false);
		expect(report.counts.failed).toBe(1);
	});
	it('records component scope and immutable receipts without claiming live golden acceptance', () => {
		const root = fixture();
		writeFileSync(resolve(root, 'node_modules/vitest/vitest.mjs'), caseProgram('process.stdout.write(JSON.stringify({success:true,numPassedTests:1,numFailedTests:0,testResults:[{assertionResults:[{title:"proves the boundary",status:"passed",duration:1}]}]}));'));
		const report = runLocalGuarantees(root, planLocalGuarantees(root, ['proof']), 'regression');
		expect(report.ok).toBe(true);
		expect(report.scope).toBe('local-component-tests');
		expect(report.results[0]?.evidence).toHaveLength(2);
		expect(report.results[0]?.evidence[1]).toContain('prerequisite-');
		expect(() => runLocalGuarantees(root, planLocalGuarantees(root, ['proof']), 'regression')).toThrow('immutable');
	});
	it('uses only the selected native report destination and denies missing malformed failed or foreign evidence despite passing stdout', () => {
		const valid = {success:true,numPassedTests:1,numFailedTests:0,testResults:[{assertionResults:[{title:'proves the boundary',status:'passed',duration:1}]}]};
		for (const mode of ['valid','missing','malformed','failed','foreign']) {
			const root = fixture();
			const supplied = mode === 'malformed' ? '{' : JSON.stringify(mode === 'failed' ? {...valid,success:false,numFailedTests:1} :
				mode === 'foreign' ? {...valid,testResults:[{assertionResults:[{title:'foreign boundary',status:'passed',duration:1}]}]} : valid);
			const source = `const destination=process.argv.find(value=>value.startsWith('--outputFile='))?.slice('--outputFile='.length);
				if(destination && ${mode !== 'missing'})(await import('node:fs')).writeFileSync(destination,${JSON.stringify(supplied)});
				process.stdout.write(${JSON.stringify(mode === 'valid' ? '[{"filename":"native-runtime.tgz"}]\n' : JSON.stringify(valid))});`;
			writeFileSync(resolve(root,'node_modules/vitest/vitest.mjs'),caseProgram(source));
			const report = runLocalGuarantees(root,planLocalGuarantees(root,['proof']),`selected-${mode}`);
			expect(report.ok).toBe(mode === 'valid');
			expect(readFileSync(resolve(root,'node_modules/vitest/vitest.mjs'),'utf8')).toBe(caseProgram(source));
		}
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
		writeFileSync(resolve(root, 'node_modules/vitest/vitest.mjs'), caseProgram('process.stdout.write(JSON.stringify({success:false,numPassedTests:0,numFailedTests:1,testResults:[]}));'));
		const report = runLocalGuarantees(root, plan, 'regression');
		expect(report.results.map(result => result.status)).toEqual(['failed', 'blocked']);
		expect(report.ok).toBe(false);
	});
});
