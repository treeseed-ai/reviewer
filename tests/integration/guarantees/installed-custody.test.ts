import { afterEach, expect, it, onTestFailed } from 'vitest';
import { appendFileSync, unlinkSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fixture, roots } from '../../fixtures/guarantee-prerequisites.ts';
import { planLocalGuarantees, runLocalGuarantees } from '../../../src/verifiers/guarantees/command.ts';
import { candidate, runPrerequisites } from '../../../src/verifiers/guarantees/prerequisites.ts';
import { runOwnedCommand } from '../../../src/verifiers/guarantees/owned-command.ts';

let installationRoot:string,installed:string,owner:string,runner:string,source:string,workspace:string;
const phases:{phase:string;durationMs:number;remainingMs:number}[]=[];
const original="import test from 'node:test';import assert from 'node:assert/strict';import{readFileSync}from'node:fs';import{value}from'./helper.ts';test('installed native bytes',()=>{assert.equal(value,'exact native bytes');assert.equal(readFileSync(new URL('./payload.txt',import.meta.url),'utf8'),'actual archived payload');});";
function native(phase:string,command:string,args:string[],cwd:string,deadline:number) {
 const timeout=Math.floor(deadline-performance.now());
 let label=`ACCEPTANCE_INSTALLED_${phase}: Original native command boundary`;
 expect(timeout,label).toBeGreaterThan(0);
 const started=performance.now();
 const result=runOwnedCommand(command,args,{cwd,encoding:'utf8',timeout,maxBuffer:8*1024*1024});
 phases.push({phase,durationMs:performance.now()-started,remainingMs:deadline-performance.now()});
 const code=(result.error as NodeJS.ErrnoException|undefined)?.code;
 if(code&&['ETIMEDOUT','ENOENT','EACCES','EAGAIN','ENOBUFS','VERIFIER_SUBPROCESS_RESIDUE','VERIFIER_SUBPROCESS_CLOSURE_UNPROVEN'].includes(code))
  label=`ACCEPTANCE_INSTALLED_${phase}_${code}: Original native command boundary`;
 expect(result.error,label).toBeUndefined();expect(result.signal,label).toBeNull();return result;
}
function createProductionInstallation(deadline:number) {
 installationRoot=mkdtempSync(resolve(tmpdir(),'reviewer-production-archive-'));
 const repository=resolve(import.meta.dirname,'../../..');workspace=resolve(installationRoot,'workspace');source=resolve(workspace,'packages/native');
 mkdirSync(resolve(workspace,'packages'),{recursive:true});renameSync(fixture(),source);symlinkSync(repository,resolve(workspace,'packages/reviewer'),'dir');
 mkdirSync(resolve(source,'assets'));
 writeFileSync(resolve(source,'package.json'),JSON.stringify({name:'@fixture/installed',version:'1.0.0',type:'module',files:['assets','guarantees','treeseed.package.yaml'],scripts:{test:'vitest run --config ./vitest.config.ts'}}));
 writeFileSync(resolve(source,'guarantees/proof.guarantee.yaml'),'id: proof\nownerPackage: "@fixture/installed"\nscene: { required: true, manifest: guarantees/proof.scene.yaml }\n');
 writeFileSync(resolve(source,'guarantees/proof.scene.yaml'),JSON.stringify({scope:'local-component-tests',workflow:[{id:'native',action:{verifier:'proof.scene'},expect:{status:'passed'}}]}));
 writeFileSync(resolve(source,'guarantees/proof.verifiers.yaml'),JSON.stringify({verifiers:{'proof.scene':{kind:'nodeTestCase',ownerPackage:'@fixture/installed',testFile:'assets/proof.test.ts',testName:'installed native bytes'}}}));
 writeFileSync(resolve(source,'assets/proof.test.ts'),original);writeFileSync(resolve(source,'assets/helper.ts'),"export const value='exact native bytes';");
 writeFileSync(resolve(source,'assets/payload.txt'),'actual archived payload');
 const dependencySource=resolve(repository,'node_modules/@treeseed/sdk');
 expect(lstatSync(dependencySource).isSymbolicLink()).toBe(false);expect(realpathSync(dependencySource)).toBe(dependencySource);
 const dependencyManifest=JSON.parse(readFileSync(resolve(dependencySource,'package.json'),'utf8'));
 expect(dependencyManifest.name).toBe('@treeseed/sdk');
 const inputs=[source,repository,dependencySource],dependencyBytes=new Map<string,Buffer>();
 const packed=native('PACK','npm',['pack',...inputs,'--ignore-scripts','--json','--pack-destination',installationRoot],repository,deadline);
 expect(packed.status,packed.stderr).toBe(0);
 const entries=JSON.parse(packed.stdout) as {name:string;filename:string;files:{path:string}[]}[];
 expect(entries).toHaveLength(inputs.length);
 const archives=inputs.map(cwd=>{
  const name=JSON.parse(readFileSync(resolve(cwd,'package.json'),'utf8')).name;
  const matches=entries.filter(entry=>entry.name===name);expect(matches).toHaveLength(1);const archive=matches[0]!;
  if(cwd===dependencySource)for(const file of archive.files)
   if(file.path!=='package.json')dependencyBytes.set(file.path,readFileSync(resolve(cwd,file.path)));
  return resolve(installationRoot,archive.filename);
 });
 const prefix=installationRoot;
 writeFileSync(resolve(prefix,'package.json'),JSON.stringify({private:true,type:'module',
  dependencies:Object.fromEntries(inputs.map((cwd,index)=>[JSON.parse(readFileSync(resolve(cwd,'package.json'),'utf8')).name,`file:${archives[index]}`])),
  overrides:{'@treeseed/sdk':'$@treeseed/sdk'}}));
 const installation=native('INSTALL','npm',['install','--prefix',prefix,'--omit=dev','--ignore-scripts','--package-lock=false','--no-save',
  '--no-audit','--no-fund',...archives],installationRoot,deadline);
 expect(installation.status,installation.stderr).toBe(0);
 expect(dependencyBytes.size).toBeGreaterThan(0);
 for(const [path,bytes]of dependencyBytes)expect(readFileSync(resolve(prefix,'node_modules/@treeseed/sdk',path)).equals(bytes),
  'ACCEPTANCE_INSTALLED_DEPENDENCY_BYTES: Every archived SDK asset must retain exact bytes').toBe(true);
 const installedDependency=JSON.parse(readFileSync(resolve(prefix,'node_modules/@treeseed/sdk/package.json'),'utf8'));
 for(const field of ['name','version','exports','dependencies'])expect(installedDependency[field]).toEqual(dependencyManifest[field]);
 const dependency=native('DEPENDENCY_EXPORTS',process.execPath,['--input-type=module','-e',"await import('@treeseed/sdk/operator-contracts')"],installationRoot,deadline);
 expect(dependency.status,'ACCEPTANCE_INSTALLED_DEPENDENCY_EXPORTS: Actual production SDK exports must resolve without checkout source').toBe(0);
 installed=resolve(prefix,'node_modules');owner=resolve(installed,'@fixture/installed');runner=resolve(installed,'@treeseed/reviewer/dist/verifiers/guarantees/node-case.js');
 expect(existsSync(resolve(installed,'vitest'))).toBe(false);
 expect(existsSync(resolve(installed,'@treeseed/cli')),
  'Reviewer must execute its own runner without installing an unused companion CLI').toBe(false);
}
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});

it('blocks missing installed owner custody before source suites or source scene fallback',()=>{
 const root=fixture();
 const report=runLocalGuarantees(root,planLocalGuarantees(root,['proof']),'missing-installed',resolve(root,'missing-install/node_modules'));
 expect(report.ok).toBe(false);
 expect(report.results[0]!.steps.every(step=>step.status==='blocked')).toBe(true);
 expect(existsSync(resolve(root,'.treeseed/order'))).toBe(false);
 expect(report.diagnostics!.some(diagnostic=>diagnostic.message.includes('Installed'))).toBe(true);
});

it('holds and executes the explicitly supplied runner source whole suite once without traversing unrelated companion targets',()=>{
 const root=fixture(),runnerSource=fixture(),output=resolve(root,'.treeseed/runner-prerequisites');
 mkdirSync(resolve(output,'evidence'),{recursive:true});
 writeFileSync(resolve(runnerSource,'treeseed.package.yaml'),JSON.stringify({development:{project:{id:'arbitrary-runner'},targets:[{id:'browser',dependencies:[{id:'unrelated-browser-peer',target:'browser'}]}]}}));
 const held=candidate(runnerSource),proof=runPrerequisites(planLocalGuarantees(root,['proof']),output,root,runnerSource);
 expect(proof.diagnostics).toEqual([]);expect(proof.receipts).toHaveLength(2);
 expect(proof.candidates.get(runnerSource)).toEqual(held);
 for(const receipt of proof.receipts)expect(JSON.parse(readFileSync(resolve(output,receipt),'utf8'))).toMatchObject({passed:true,checks:{total:2,passed:2,failed:0,skipped:0,todo:0}});
 for(const directory of [root,runnerSource])expect(readFileSync(resolve(directory,'.treeseed/order'),'utf8').trim().split('\n').sort()).toEqual(['integration','unit']);
 expect(candidate(runnerSource)).toEqual(held);
});

it('executes actual production-installed Reviewer and owner archives and retains denied checkout imports and missing-helper failures before exact retry',()=>{
 const deadline=performance.now()+30_000,workDeadline=deadline-5_000;let originalFailure:unknown;
 phases.length=0;onTestFailed(()=>{throw new Error('ACCEPTANCE_INSTALLED_PHASE_MEASUREMENTS: '+JSON.stringify(phases));});
 try {
 expect(()=>native('EXECUTE',process.execPath,['-e','Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5000)'],tmpdir(),performance.now()+25))
  .toThrow('ACCEPTANCE_INSTALLED_EXECUTE_ETIMEDOUT');
 createProductionInstallation(workDeadline);
 const command=resolve(installed,'@treeseed/reviewer/dist/verifiers/guarantees/command.js');
 const planned=native('PLAN',process.execPath,[command,'--workspace',workspace,'--ids','proof','--plan','--installed-packages',installed],installationRoot,workDeadline);
 expect(planned.error).toBeUndefined();expect(planned.status,planned.stderr+planned.stdout).toBe(0);
 expect(JSON.parse(planned.stdout)).toMatchObject({ok:true,entries:[{id:'proof',verifierRefs:['proof.scene']}]});
 expect(existsSync(resolve(source,'.treeseed/order'))).toBe(false);
 const asset=resolve(owner,'assets/proof.test.ts'),helper=resolve(owner,'assets/helper.ts'),helperBytes=readFileSync(helper);
 const invoke=()=>{
  const result=native('EXECUTE',process.execPath,[runner,asset,'installed native bytes',installed],owner,workDeadline);
  expect(result.error).toBeUndefined();expect(result.signal).toBeNull();return {result,report:JSON.parse(result.stdout)};
 };
 const first=invoke();expect(first.result.status,first.result.stderr).toBe(0);expect(first.report).toMatchObject({success:true,numPassedTests:1,numFailedTests:0});
 const failures:Buffer[]=[];
 for(const shape of ['checkout-import','missing-helper']) {
  if(shape==='checkout-import')writeFileSync(asset,original.replace("'./helper.ts'",JSON.stringify(resolve(source,'assets/helper.ts'))));
  else rmSync(helper);
  const denied=invoke();expect(denied.result.status,shape).toBe(1);expect(denied.report.success,shape).toBe(false);expect(denied.report.numFailedTests,shape).toBeGreaterThan(0);
  const retained=resolve(installationRoot,`${shape}.json`);writeFileSync(retained,denied.result.stdout);failures.push(readFileSync(retained));
  writeFileSync(asset,original);writeFileSync(helper,helperBytes);
 }
 const retry=invoke();expect(retry.result.status,retry.result.stderr).toBe(0);expect(retry.report.success).toBe(true);
 for(const [index,shape] of ['checkout-import','missing-helper'].entries())expect(readFileSync(resolve(installationRoot,`${shape}.json`))).toEqual(failures[index]);
 expect(readFileSync(resolve(source,'assets/proof.test.ts'),'utf8')).toBe(original);
 expect(readFileSync(resolve(source,'assets/helper.ts'))).toEqual(helperBytes);
 } catch(error) { originalFailure=error;throw error; }
 finally {
  try {if(installationRoot) {rmSync(installationRoot,{recursive:true,force:true});expect(existsSync(installationRoot)).toBe(false);}
   expect(performance.now(),'ACCEPTANCE_INSTALLED_CLOSE: Original thirty-second boundary includes scoped cleanup').toBeLessThan(deadline);
  } catch(cleanupFailure) {throw originalFailure?new AggregateError([originalFailure,cleanupFailure],'Original installed proof and scoped cleanup both failed'):cleanupFailure;}
 }
});

it('retains a real full-suite controlled failure stage without copying native failure prose',()=>{
 const root=fixture();
 appendFileSync(resolve(root,'tests/unit.test.ts'),`
import {spawnSync} from 'node:child_process'; import {performance} from 'node:perf_hooks'; import {onTestFailed} from 'vitest'; import {writeFileSync,existsSync} from 'node:fs';
 it('controlled failure',()=>{if(!existsSync('.treeseed/fail-installed-phase'))return;
 const started=performance.now(),deadline=started+5000;
 const result=spawnSync(process.execPath,['-e',"process.stderr.write('private native error');process.exit(7)"],{encoding:'utf8',timeout:5000});
 const measurements=[{phase:'EXECUTE',durationMs:performance.now()-started,remainingMs:deadline-performance.now()}];
 writeFileSync('.treeseed/installed-phase.json',JSON.stringify(measurements));
 onTestFailed(()=>{throw new Error('ACCEPTANCE_INSTALLED_PHASE_MEASUREMENTS: '+JSON.stringify(measurements));});
 expect(result.status,'ACCEPTANCE_PREREQUISITE_FIXTURE: private native error').toBe(0);});
`);
 writeFileSync(resolve(root,'.treeseed/fail-installed-phase'),'controlled failure input');
 const held=candidate(root),plan=planLocalGuarantees(root,['proof']);
 const report=runLocalGuarantees(root,plan,'controlled-failure'); expect(report.ok).toBe(false);
 const path=resolve(root,'.treeseed/guarantees/runs/controlled-failure',report.results[0]!.evidence[0]!);
 const bytes=readFileSync(path),receipt=JSON.parse(bytes.toString('utf8'));
 const measurements=JSON.parse(readFileSync(resolve(root,'.treeseed/installed-phase.json'),'utf8'));
 expect(measurements[0].durationMs).toBeGreaterThan(0);expect(measurements[0].remainingMs).toBeGreaterThan(0);
 expect(receipt.checks.failures).toEqual([{title:'controlled failure',status:'failed',criterion:'ACCEPTANCE_PREREQUISITE_FIXTURE',measurements}]);
 expect(JSON.stringify(receipt)).not.toContain('private native error');
 expect(readFileSync(resolve(root,'.treeseed/order'),'utf8')).not.toContain('scene');
 unlinkSync(resolve(root,'.treeseed/fail-installed-phase'));
 expect(candidate(root)).toEqual(held);expect(runLocalGuarantees(root,plan,'controlled-retry').ok).toBe(true);
 expect(readFileSync(path)).toEqual(bytes);expect(candidate(root)).toEqual(held);
});
