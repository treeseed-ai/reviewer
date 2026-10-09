import {afterEach,expect,it} from 'vitest';
import {mkdirSync,mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync,symlinkSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {planLocalGuarantees,runLocalGuarantees} from '../../src/verifiers/guarantees/command.ts';
import {exunitSuite} from '../fixtures/exunit-suite.ts';

const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture(mode='pass') {
	const root=mkdtempSync(resolve(tmpdir(),'guarantee-exunit-'));roots.push(root);
	for(const name of ['.treeseed','guarantees'])mkdirSync(resolve(root,name));
	symlinkSync(resolve(import.meta.dirname,'../../node_modules'),resolve(root,'node_modules'));
	writeFileSync(resolve(root,'.gitignore'),'node_modules\n.treeseed\n');
	writeFileSync(resolve(root,'candidate.ts'),'unchanged source');
	writeFileSync(resolve(root,'verify.exs'),exunitSuite(mode));
	writeFileSync(resolve(root,'treeseed.package.yaml'),'verify: {local: verify.exs}\ndevelopment: {project: {id: native}, targets: [{id: suite}]}\n');
	writeFileSync(resolve(root,'scene.mts'),"import test from 'node:test';import {appendFileSync} from 'node:fs';test('scene',()=>{appendFileSync('.treeseed/order','scene\\n');});");
	writeFileSync(resolve(root,'guarantees/native.guarantee.yaml'),'id: native\napi: {verifierRefs: [native.scene]}\n');
	writeFileSync(resolve(root,'guarantees/native.verifiers.yaml'),'verifiers:\n  native.scene: {kind: nodeTestCase, testFile: scene.mts, testName: scene}\n');
	for(const args of [['init','-q'],['add','.'],['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','Exact native candidate']])
		expect(spawnSync('git',args,{cwd:root}).status).toBe(0);
	return root;
}
function invoke(root:string,id:string) {
	const report=runLocalGuarantees(root,planLocalGuarantees(root,['native']),id);
	const evidence=report.results[0]!.evidence.find(path=>path.includes('prerequisite-'))!;
	const receipt=JSON.parse(readFileSync(resolve(root,'.treeseed/guarantees/runs',id,evidence),'utf8'));
	const scene=report.results[0]!.evidence.filter(path=>!path.includes('prerequisite-')).map(path=>JSON.parse(readFileSync(resolve(root,'.treeseed/guarantees/runs',id,path),'utf8')));
	return {report,receipt,scene};
}

it('executes declared shell whole suites with real native assertions before scenes and retains failed attempts on fresh retry',()=>{
	const root=fixture();
	writeFileSync(resolve(root,'verify.sh'),'#!/usr/bin/env bash\nset -euo pipefail\nexec elixir verify.exs\n');
	writeFileSync(resolve(root,'treeseed.package.yaml'),'verify: {local: verify.sh}\n');
	for(const [id,mode,passed] of [['shell-first','pass',true],['shell-failed','failure',false],['shell-retry','pass',true]] as const) {
		writeFileSync(resolve(root,'verify.exs'),exunitSuite(mode));
		const {report,receipt}=invoke(root,id);
		expect(report.ok,JSON.stringify(receipt)).toBe(passed);
		expect(receipt).toMatchObject({passed,exitCode:passed?0:2,checks:{total:2,passed:passed?2:1,skipped:0,todo:0}});
		expect(receipt.command).toEqual(['bash',resolve(root,'verify.sh')]);
	}
	const failed=readFileSync(resolve(root,'.treeseed/guarantees/runs/shell-failed/report.json'),'utf8');
	expect(JSON.parse(failed).ok).toBe(false);
	expect(readFileSync(resolve(root,'.treeseed/order'),'utf8')).toBe('suite\nscene\nsuite\nsuite\nscene\n');
});

it('blocks declared shell skipped excluded empty missing truncated mixed interrupted and mutating native reports before scenes',()=>{
	for(const mode of ['skip','excluded','empty','missing','truncated','mixed','interrupted','mutation']) {
		const root=fixture(mode);
		writeFileSync(resolve(root,'verify.sh'),mode==='interrupted'?'kill -TERM $$\n':'set -euo pipefail\nexec elixir verify.exs\n');
		writeFileSync(resolve(root,'treeseed.package.yaml'),'verify: {local: verify.sh}\n');
		const {report,receipt}=invoke(root,mode);
		expect(report.ok,mode).toBe(false);expect(receipt.passed,mode).toBe(false);
		expect(receipt.command).toEqual(['bash',resolve(root,'verify.sh')]);
		if(mode==='interrupted')expect(receipt.signal).toBe('SIGTERM');
		expect(existsSync(resolve(root,'.treeseed/order'))?readFileSync(resolve(root,'.treeseed/order'),'utf8'):'').not.toContain('scene');
	}
});

it('admits declared complete ExUnit assertions once before scenes and reruns them only for a new invocation',()=>{
	const root=fixture();
	for(const id of ['first','second']) {
		const {report,receipt,scene}=invoke(root,id);
		expect(report.ok,JSON.stringify({receipt,scene})).toBe(true);
		expect(receipt).toMatchObject({passed:true,exitCode:0,checks:{total:2,passed:2,failed:0,skipped:0,todo:0}});
		expect(receipt.command).toEqual(['elixir',resolve(root,'verify.exs')]);
	}
	expect(readFileSync(resolve(root,'.treeseed/order'),'utf8')).toBe('suite\nscene\nsuite\nscene\n');
});

it('blocks real ExUnit failed skipped and excluded assertions even when skipped frameworks exit zero',()=>{
	for(const mode of ['failure','skip','excluded']) {
		const root=fixture(mode);const {report,receipt}=invoke(root,mode);
		expect(report.ok,mode).toBe(false);expect(receipt.passed,mode).toBe(false);
		expect(receipt.checks,mode).toMatchObject({total:2,passed:1});
		expect(receipt.exitCode).toBe(mode==='failure'?2:0);
		expect(receipt.checks.failures).toEqual([{title:'test real process integration',status:mode==='failure'?'failed':'pending'}]);
		expect(JSON.stringify(receipt)).not.toContain('private native');
		expect(readFileSync(resolve(root,'.treeseed/order'),'utf8')).toBe('suite\n');
	}
});

it('blocks empty missing truncated and mixed ExUnit evidence instead of accepting a process exit code',()=>{
	for(const mode of ['empty','missing','truncated','mixed']) {
		const root=fixture(mode);const {report,receipt}=invoke(root,mode);
		expect(report.ok,mode).toBe(false);expect(receipt.passed,mode).toBe(false);
		expect(receipt.exitCode,mode).toBe(0);
		expect(JSON.stringify(receipt)).not.toContain('private native');
		expect(readFileSync(resolve(root,'.treeseed/order'),'utf8')).toBe('suite\n');
	}
});

it('rejects a zero-exit ExUnit suite that mutates its exact candidate after all assertions pass',()=>{
	const root=fixture('mutation');const {report,receipt}=invoke(root,'mutation');
	expect(report.ok).toBe(false);
	expect(receipt).toMatchObject({passed:false,exitCode:0,checks:{total:2,passed:2}});
	expect(readFileSync(resolve(root,'.treeseed/order'),'utf8')).toBe('suite\n');
});

it('preflights declared ExUnit filters hooks missing and escaped scripts before any native execution',()=>{
	for(const mode of ['filtered','hook','missing','escaped','shell']) {
		const root=fixture();let path='verify.exs';
		if(mode==='filtered')path+=' --only selected';
		if(mode==='hook')path+=' && echo private';
		if(mode==='missing')path='missing.exs';
		if(mode==='shell')path='verify.sh';
		if(mode==='escaped') {
			const outside=mkdtempSync(resolve(tmpdir(),'guarantee-exunit-outside-'));roots.push(outside);
			writeFileSync(resolve(outside,'outside.exs'),exunitSuite('pass'));
			path='escaped.exs';symlinkSync(resolve(outside,'outside.exs'),resolve(root,path));
		}
		writeFileSync(resolve(root,'treeseed.package.yaml'),`verify: {local: ${JSON.stringify(path)}}\n`);
		const {report,receipt}=invoke(root,mode);
		expect(report.ok,mode).toBe(false);expect(receipt.command,mode).toEqual([]);
		expect(receipt.checks,mode).toBeNull();expect(existsSync(resolve(root,'.treeseed/order')),mode).toBe(false);
	}
});
