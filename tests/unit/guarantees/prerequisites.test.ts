import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { candidate, custodyDiagnostics, fullSuitePassed, ownerTestCommand } from '../../../src/verifiers/guarantees/prerequisites.ts';

const report = () => ({ success: true, numTotalTests: 2, numPassedTests: 2, numFailedTests: 0,
	numPendingTests: 0, numTodoTests: 0, numFailedTestSuites: 0, numPendingTestSuites: 0,
	testResults: [{ assertionResults: [{title:'unit',status:'passed',duration:1}, {title:'integration',status:'passed',duration:2}] }] });
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root,{recursive:true,force:true}); });

it('accepts only complete observed full-suite evidence without skipped pending or failed boundaries', () => {
	expect(fullSuitePassed(report())).toBe(true);
	for (const patch of [{success:false},{numTotalTests:0},{numTotalTests:'2'},{numTotalTests:3},{numPassedTests:1},
		{numFailedTests:1},{numPendingTests:1},{numTodoTests:1},{numFailedTestSuites:1},{numPendingTestSuites:1},
		{testResults:[]},{testResults:[{assertionResults:[]}]},{testResults:null}])
		expect(fullSuitePassed({...report(),...patch}),JSON.stringify(patch)).toBe(false);
	for (const value of [null,{},[],true,'passed']) expect(fullSuitePassed(value)).toBe(false);
});

it('rejects malformed skipped failed absent and unmeasured assertion evidence', () => {
	for (const patch of [{status:'skipped'},{status:'failed'},{status:'todo'},{title:''},{duration:-1},
		{duration:undefined},{duration:Infinity},{duration:Number.NaN},{duration:'1'}]) {
		const value = report(); Object.assign(value.testResults[0]!.assertionResults[0]!,patch);
		expect(fullSuitePassed(value),JSON.stringify(patch)).toBe(false);
	}
});

it('resolves the declared complete test entrypoint without filters and rejects cyclic missing or hooked delegation', () => {
	const root = mkdtempSync(resolve(tmpdir(),'prerequisite-script-')); roots.push(root);
	const save = (scripts: Record<string,string>) => writeFileSync(resolve(root,'package.json'),JSON.stringify({scripts}));
	save({test:'npm run test:all','test:all':'vitest run --config vitest.config.ts'});
	expect(ownerTestCommand(root)).toBe('vitest run --config vitest.config.ts');
	for (const scripts of [{},{test:'npm run missing'},{test:'npm run cycle',cycle:'npm run test'},
		{test:'vitest run',pretest:'echo partial'},{test:'vitest run',posttest:'echo extra'},
		{test:'npm run all',all:'vitest run',preall:'echo partial'}]) {
		save(scripts); expect(() => ownerTestCommand(root)).toThrow();
	}
});

it('compares both exact HEAD and source bytes without disclosing source contents', () => {
	const root = mkdtempSync(resolve(tmpdir(),'prerequisite-custody-')); roots.push(root);
	writeFileSync(resolve(root,'candidate.ts'),'private source content');
	for (const args of [['init','-q'],['add','.'],['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','Candidate']])
		expect(spawnSync('git',args,{cwd:root}).status).toBe(0);
	const expected = candidate(root);
	expect(custodyDiagnostics(new Map([[root,expected]]))).toEqual([]);
	for (const patch of [{commit:'0'.repeat(40)},{sourceDigest:'0'.repeat(64)}]) {
		const errors = custodyDiagnostics(new Map([[root,{...expected,...patch}]]));
		expect(errors).toHaveLength(1); expect(errors.join(' ')).not.toContain('private source content');
	}
	writeFileSync(resolve(root,'candidate.ts'),'changed private content');
	expect(custodyDiagnostics(new Map([[root,expected]]))).toHaveLength(1);
});

it('rejects missing candidate custody without throwing or substituting an old receipt', () => {
	const root = mkdtempSync(resolve(tmpdir(),'prerequisite-no-git-')); roots.push(root);
	expect(custodyDiagnostics(new Map([[root,{commit:'0'.repeat(40),sourceDigest:'0'.repeat(64)}]]))).toHaveLength(1);
});
