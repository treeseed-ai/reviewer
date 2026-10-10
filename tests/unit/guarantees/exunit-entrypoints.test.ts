import {afterEach,expect,it} from 'vitest';
import {mkdtempSync,writeFileSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {ownerTestCommand,fullSuiteFailures} from '../../../src/verifiers/guarantees/prerequisites.ts';

const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture() {
	const root=mkdtempSync(resolve(tmpdir(),'exunit-entrypoint-'));roots.push(root);return root;
}

it('resolves one complete native Elixir entrypoint from the existing owner verification declaration',()=>{
	const root=fixture();writeFileSync(resolve(root,'treeseed.package.yaml'),'verify: {local: scripts/verify.exs}\n');
	expect(ownerTestCommand(root)).toBe('elixir scripts/verify.exs');
});

it('rejects missing malformed filtered and shell expressions without borrowing an npm identity',()=>{
	const root=fixture();
	for(const value of ['{}','verify: null','verify: {local: null}','verify: {local: [verify.exs]}',
		'verify: {local: "verify.sh --only selected"}','verify: {local: "verify.exs --only selected"}',
		'verify: {local: "elixir verify.exs"}','verify: {local: "verify.exs && true"}',
		'verify: {local: /tmp/verify.exs}','verify: {local: -verify.exs}']) {
		writeFileSync(resolve(root,'treeseed.package.yaml'),value);
		expect(()=>ownerTestCommand(root),value).toThrow();
	}
	writeFileSync(resolve(root,'treeseed.package.yaml'),'verify: {local: verify.exs}\n');
	writeFileSync(resolve(root,'package.json'),JSON.stringify({scripts:{}}));
	expect(()=>ownerTestCommand(root)).toThrow();
});

it('retains only controlled prerequisite failure criteria without copying stack or assertion prose',()=>{
	const evidence={testResults:[{assertionResults:[
		{title:'boundary',status:'failed',failureMessages:['AssertionError: ACCEPTANCE_PREREQUISITE_GIT_INIT: private native error\nprivate stack']},
		{title:'other',status:'failed',failureMessages:['Error: private native error']},
		{title:'passed',status:'passed',failureMessages:['Error: private native error']}
	]}]};
	expect(fullSuiteFailures(evidence)).toEqual([
		{title:'boundary',status:'failed',criterion:'ACCEPTANCE_PREREQUISITE_GIT_INIT'},
		{title:'other',status:'failed'}
	]);
	expect(JSON.stringify(fullSuiteFailures(evidence))).not.toContain('private');
});

it('retains unknown framework failure causes without inventing criteria or leaking duration stacks or assertion values',()=>{
	for (const milliseconds of [25, 5_000, 30_000]) {
		const evidence = { testResults: [{ assertionResults: [{ title: 'native execution', status: 'failed',
			failureMessages: [`Error: Test timed out in ${milliseconds}ms.\nprivate stack and secret value`] }] }] };
		expect(fullSuiteFailures(evidence)).toEqual([{ title: 'native execution', status: 'failed' }]);
		expect(JSON.stringify(fullSuiteFailures(evidence))).not.toContain('private');
	}
	for (const message of ['Error: STACK_TRACE_ERROR\nprivate stack', 'Error: private timeout token', 'Error: Test timed out in secretms.',
		'AssertionError: expected secret Test timed out in 25ms.', 'prefix\nError: Test timed out in 25ms.',
		'Error: Test timed out in 25ms. token=secret']) {
		expect(fullSuiteFailures({ testResults: [{ assertionResults: [{ title: 'failed', status: 'failed', failureMessages: [message] }] }] }))
			.toEqual([{ title: 'failed', status: 'failed' }]);
	}
});

it('retains the first controlled criterion from later native failure messages without copying private causes or mutating observations',()=>{
	const evidence={testResults:[{assertionResults:[
		{title:'native phase',status:'failed',failureMessages:['Error: private original cause',
			'Error: ACCEPTANCE_NATIVE_PHASE_COMPILE: private hook cause\nprivate stack',
			'Error: ACCEPTANCE_NATIVE_PHASE_CLOSE: private later cause']},
		{title:'uncontrolled',status:'failed',failureMessages:[null,'private prefix ACCEPTANCE_NATIVE_PHASE_COMPILE:',
			'prefix\nError: ACCEPTANCE_NATIVE_PHASE_COMPILE: private stack']},
		{title:'passed',status:'passed',failureMessages:['Error: ACCEPTANCE_NATIVE_PHASE_COMPILE: private hook cause']}
	]}]}, held=structuredClone(evidence);
	expect(fullSuiteFailures(evidence)).toEqual([
		{title:'native phase',status:'failed',criterion:'ACCEPTANCE_NATIVE_PHASE_COMPILE'},
		{title:'uncontrolled',status:'failed'}
	]);
	expect(evidence).toEqual(held); expect(JSON.stringify(fullSuiteFailures(evidence))).not.toContain('private');
});

it('retains owned failed collection files without inventing assertion identities or leaking native loader prose',()=>{
 const root=fixture(),file=resolve(root,'unavailable.test.ts');writeFileSync(file,"import '@fixture/missing';");
 const linked=resolve(root,'private-link.test.ts');symlinkSync(file,linked);
 const unavailable=[resolve(root,'../private.test.ts'),resolve(root,'private-missing.test.ts'),root,linked,'private-relative.test.ts','',null,42];
 const evidence={testResults:[{name:file,status:'failed',assertionResults:[],message:'private loader token stack'},
  ...unavailable.map(name=>({name,status:'failed',assertionResults:[],message:'private outside path'})),
  {name:file,status:'passed',assertionResults:[]}]},held=structuredClone(evidence);
 expect(fullSuiteFailures(evidence,root)).toEqual([{file:'unavailable.test.ts',status:'collection_failed'},
  ...unavailable.map(()=>({file:null,status:'collection_failed'}))]);
 expect(JSON.stringify(fullSuiteFailures(evidence,root))).not.toContain('private');expect(evidence).toEqual(held);
});
