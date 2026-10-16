import { afterEach, expect, it, onTestFailed, vi } from 'vitest';
import { appendFileSync, chmodSync, cpSync, unlinkSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, resolve } from 'node:path';
import ts from 'typescript';
import { fixture, roots, productionDependencyArchives, productionInstallFlags } from '../../fixtures/guarantee-prerequisites.ts';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { planLocalGuarantees, runLocalGuarantees } from '../../../src/verifiers/guarantees/command.ts';
import { candidate, runPrerequisites } from '../../../src/verifiers/guarantees/prerequisites.ts';
import { runOwnedCommand } from '../../../src/verifiers/guarantees/owned-command.ts';
import { sourceRunnerFixture } from '../../fixtures/source-runner.ts';
import { acceptanceCriteria } from '../../../src/verifiers/guarantees/acceptance-spec.ts';
import { inspectInstalledOwner } from '../../../src/verifiers/guarantees/installed-custody.ts';

let installationRoot:string,installed:string,owner:string,runner:string,source:string,workspace:string;
const phases:{phase:string;durationMs:number;remainingMs:number}[]=[];
const original="import test from 'node:test';import assert from 'node:assert/strict';import{readFileSync}from'node:fs';import{execFileSync}from'node:child_process';import{value}from'./helper.ts';test('installed native bytes',()=>{assert.equal(value,'exact native bytes');assert.equal(readFileSync(new URL('./payload.txt',import.meta.url),'utf8'),'actual archived payload');for(const command of ['fixture-installed-command','fixture-bundled-command'])assert.equal(execFileSync(command,[],{encoding:'utf8'}),'actual archived command');});test('installed owner failure classification',()=>{throw Object.assign(new Error('PRIVATE_INSTALLED_OWNER_DETAILS'),{classification:'OWNER_REQUIRES_REVIEW'});});";
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
function createProductionInstallation(deadline:number,integrated=false) {
 installationRoot=mkdtempSync(resolve(tmpdir(),'reviewer-production-archive-'));
 const repository=resolve(import.meta.dirname,'../../..');workspace=resolve(installationRoot,'workspace');source=resolve(workspace,'packages/native');
 const dependencies=productionDependencyArchives(installationRoot,args=>native('DEPENDENCY_PACK','npm',args,repository,deadline));
 mkdirSync(resolve(workspace,'packages'),{recursive:true});renameSync(fixture(),source);
 if(integrated) {
  const independent=sourceRunnerFixture();renameSync(independent,resolve(workspace,'packages/reviewer'));
  rmSync(resolve(workspace,'packages/reviewer/guarantees'),{recursive:true});
  for(const path of ['package.json','treeseed.package.yaml','README.md','LICENSE','dist']) {
   cpSync(resolve(repository,path),resolve(workspace,'packages/reviewer',path),{recursive:true});
   chmodSync(resolve(workspace,'packages/reviewer',path),lstatSync(resolve(repository,path)).mode&0o777);
  }
  for(const args of [['add','-A'],['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','Exact archived runner candidate']])
   expect(native('RUNNER_CANDIDATE','git',args,resolve(workspace,'packages/reviewer'),deadline).status).toBe(0);
  writeFileSync(resolve(source,'treeseed.package.yaml'),JSON.stringify({development:{project:{id:'installed-native'},targets:[{id:'runtime',dependencies:[]}]}}));
 } else symlinkSync(repository,resolve(workspace,'packages/reviewer'),'dir');
 mkdirSync(resolve(source,'assets'));
 writeFileSync(resolve(source,'package.json'),JSON.stringify({name:'@fixture/installed',version:'1.0.0',type:'module',files:['assets','guarantees','command.mjs','treeseed.package.yaml'],bin:{'fixture-installed-command':'./command.mjs'},dependencies:{'@fixture/tool':'1.0.0','native-external':dependencies.dependency},bundledDependencies:['@fixture/tool'],scripts:{test:'vitest run --config ./vitest.config.ts'}}));
 writeFileSync(resolve(source,'command.mjs'),ts.transpileModule("#!/usr/bin/env node\nimport {value} from 'native-external';if(value!==1)throw new Error('wrong native transitive authority');process.stdout.write('actual archived command');",{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText);chmodSync(resolve(source,'command.mjs'),0o755);
 const bundled=resolve(source,'node_modules/@fixture/tool');mkdirSync(bundled,{recursive:true});
 writeFileSync(resolve(bundled,'package.json'),JSON.stringify({name:'@fixture/tool',version:'1.0.0',bin:{'fixture-bundled-command':'./command.mjs'}}));
 writeFileSync(resolve(bundled,'command.mjs'),readFileSync(resolve(source,'command.mjs')));chmodSync(resolve(bundled,'command.mjs'),0o755);
 const specification='# Installed execution\n\n## Required outcomes\n- Native archived bytes remain exact.\n';
 if(integrated)writeFileSync(resolve(source,'acceptance.md'),specification);
 writeFileSync(resolve(source,'guarantees/proof.guarantee.yaml'),JSON.stringify({id:'proof',ownerPackage:'@fixture/installed',
  ...(integrated?{acceptanceCriteria:acceptanceCriteria(specification).map(value=>({criterion:value.id,verifierRefs:['proof.scene']}))}:{}),
  scene:{required:true,manifest:'guarantees/proof.scene.yaml'}}));
 writeFileSync(resolve(source,'guarantees/proof.scene.yaml'),JSON.stringify({scope:integrated?'local-integrated-runtime':'local-component-tests',workflow:[{id:'native',action:{verifier:'proof.scene'},expect:{status:'passed'}}]}));
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
 if(integrated) {
  const held=entries.find(value=>value.name==='@treeseed/reviewer')!;
  const observed=JSON.parse(native('RUNNER_INVENTORY','npm',['pack','--dry-run','--ignore-scripts','--json'],resolve(workspace,'packages/reviewer'),deadline).stdout)[0];
  const expectedFiles=new Map(held.files.map(value=>[value.path,JSON.stringify(value)]));
  const actualFiles=new Map((observed.files as {path:string}[]).map(value=>[value.path,JSON.stringify(value)]));
  const differences=[...new Set([...expectedFiles.keys(),...actualFiles.keys()])].filter(path=>expectedFiles.get(path)!==actualFiles.get(path))
   .map(path=>({path,expected:expectedFiles.get(path),actual:actualFiles.get(path)}));
  expect(differences,'Exact production Reviewer inventory copied to independent source custody').toEqual([]);
 }
 const archives=inputs.map(cwd=>{
  const name=JSON.parse(readFileSync(resolve(cwd,'package.json'),'utf8')).name;
  const matches=entries.filter(entry=>entry.name===name);expect(matches).toHaveLength(1);const archive=matches[0]!;
  if(cwd===dependencySource)for(const file of archive.files)
   if(file.path!=='package.json')dependencyBytes.set(file.path,readFileSync(resolve(cwd,file.path)));
  return resolve(installationRoot,archive.filename);
 });
 const prefix=installationRoot;
 writeFileSync(resolve(prefix,'package.json'),JSON.stringify({private:true,type:'module',
  dependencies:{...Object.fromEntries(inputs.map((cwd,index)=>[JSON.parse(readFileSync(resolve(cwd,'package.json'),'utf8')).name,`file:${archives[index]}`])),...dependencies.rootDependencies},
  overrides:{'@treeseed/sdk':'$@treeseed/sdk'}}));
 const installation=native('INSTALL','npm',['install','--prefix',prefix,...productionInstallFlags,...archives],installationRoot,deadline);
 expect(installation.status,installation.stderr).toBe(0);
 expect(dependencyBytes.size).toBeGreaterThan(0);
 for(const [path,bytes]of dependencyBytes)expect(readFileSync(resolve(prefix,'node_modules/@treeseed/sdk',path)).equals(bytes),
  'ACCEPTANCE_INSTALLED_DEPENDENCY_BYTES: Every archived SDK asset must retain exact bytes').toBe(true);
 const installedDependency=JSON.parse(readFileSync(resolve(prefix,'node_modules/@treeseed/sdk/package.json'),'utf8'));
 for(const field of ['name','version','exports','dependencies'])expect(installedDependency[field]).toEqual(dependencyManifest[field]);
 const dependency=native('DEPENDENCY_EXPORTS',process.execPath,['--input-type=module','-e',"await import('@treeseed/sdk/operator-contracts')"],installationRoot,deadline);
 expect(dependency.status,'ACCEPTANCE_INSTALLED_DEPENDENCY_EXPORTS: Actual production SDK exports must resolve without checkout source').toBe(0);
 installed=resolve(prefix,'node_modules');owner=resolve(installed,'@fixture/installed');runner=resolve(installed,'@treeseed/reviewer/dist/verifiers/guarantees/node-case.js');
 expect(JSON.parse(readFileSync(resolve(owner,'node_modules/native-transitive/value.json'),'utf8'))).toEqual({version:1});
 expect(JSON.parse(readFileSync(resolve(installed,'native-transitive/value.json'),'utf8'))).toEqual({version:2});
 expect(existsSync(resolve(installed,'vitest'))).toBe(false);
 expect(existsSync(resolve(installed,'@treeseed/cli')),
  'Reviewer must execute its own runner without installing an unused companion CLI').toBe(false);
}
afterEach(()=>{vi.unstubAllEnvs();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});

it('native integrated installed command runs fresh complete source suites and exact archived assets while denying source fallback and altered custody before retry',()=>{
 const deadline=performance.now()+30_000,workDeadline=deadline-5_000;let originalFailure:unknown;
 phases.length=0;onTestFailed(()=>{throw new Error('ACCEPTANCE_INSTALLED_PHASE_MEASUREMENTS: '+JSON.stringify(phases));});
 try {
  createProductionInstallation(workDeadline,true);
  for(const args of [['add','-A'],['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','Exact installed source candidate']])
   expect(native('OWNER_CANDIDATE','git',args,source,workDeadline).status).toBe(0);
  chmodSync(resolve(source,'assets/helper.ts'),0o600);
  expect(native('OWNER_MODE_IDENTITY','git',['status','--porcelain'],source,workDeadline).stdout).toBe('');
  const command=resolve(installed,'.bin/treeseed-reviewer-guarantees'),reviewerSource=resolve(workspace,'packages/reviewer');
  expect(inspectInstalledOwner(reviewerSource,installed).name).toBe('@treeseed/reviewer');
  const common=['--workspace',workspace,'--ids','proof','--acceptance-spec','packages/native/acceptance.md'];
  const invoke=(id:string,location=true,sourceCommand=false)=>{
   const args=[...common,'--run-id',id,...(location?['--installed-packages',installed]:[])];
   const child=sourceCommand?native('SOURCE_DENIAL',process.execPath,['--import',resolve(import.meta.dirname,'../../../node_modules/tsx/dist/loader.mjs'),
    resolve(reviewerSource,'src/verifiers/guarantees/command.ts'),...args],installationRoot,workDeadline):native('INTEGRATED',command,args,installationRoot,workDeadline);
   expect(child.stderr).toBe('');const report=JSON.parse(child.stdout),output=resolve(workspace,'.treeseed/guarantees/runs',id);
   expect(JSON.parse(readFileSync(resolve(output,'report.json'),'utf8'))).toEqual(report);return {child,report,output};
  };
  const first=invoke('installed-integrated-first');expect(first.child.status,first.child.stdout).toBe(0);
  expect(first.report).toMatchObject({ok:true,scope:'local-integrated-runtime',results:[{status:'passed',steps:[{status:'passed'}]}]});
  const evidence=first.report.results[0].evidence as string[];
  const prerequisites=evidence.filter(path=>path.includes('prerequisite-')).map(path=>JSON.parse(readFileSync(resolve(first.output,path),'utf8')));
  expect(prerequisites.map(value=>value.root).sort()).toEqual([source,reviewerSource].sort());
  for(const receipt of prerequisites)expect(receipt).toMatchObject({passed:true,exitCode:0,signal:null,checks:{total:2,passed:2,failed:0,skipped:0,todo:0}});
  const archives=evidence.filter(path=>path.startsWith('evidence/installed-')).map(path=>JSON.parse(readFileSync(resolve(first.output,path),'utf8')));
  expect(archives.map(value=>value.sourceRoot).sort()).toEqual([source,reviewerSource].sort());
  for(const value of archives){expect(value.archiveSha256).toMatch(/^[a-f0-9]{64}$/);expect(value.files.length).toBeGreaterThan(0);}
  const failed=native('OWNER_FAILURE_CODE',process.execPath,[runner,resolve(owner,'assets/proof.test.ts'),'installed owner failure classification',installed],installationRoot,workDeadline);
  expect(failed.status).toBe(1);expect(failed.stderr).toBe('');const observedFailure=JSON.parse(failed.stdout);
  expect(observedFailure).toMatchObject({success:false,numPassedTests:0,numFailedTests:1,testResults:[{assertionResults:[{title:'installed owner failure classification',status:'failed',failure:{code:'OWNER_REQUIRES_REVIEW'}}]}]});
  expect(observedFailure.testResults[0].assertionResults).toHaveLength(1);expect(failed.stdout).not.toContain('PRIVATE_INSTALLED_OWNER_DETAILS');
  const order=new Map([source,reviewerSource].map(root=>[root,readFileSync(resolve(root,'.treeseed/order'))]));
  const retained=new Map<string,Buffer>(),helper=resolve(owner,'assets/helper.ts'),helperBytes=readFileSync(helper);
  const archive=archives.find(value=>value.sourceRoot===source)!.archive as string,archiveBytes=readFileSync(archive);
  for(const mode of ['missing-location','source-runner','missing-helper','altered-archive']) {
   if(mode==='missing-helper')unlinkSync(helper);
   if(mode==='altered-archive')appendFileSync(archive,'altered original archive');
   const denied=invoke(`installed-integrated-${mode}`,mode!=='missing-location',mode==='source-runner');
   expect(denied.child.status,mode).toBe(1);expect(denied.report.ok,mode).toBe(false);
   expect(denied.report.results[0]).toMatchObject({status:'blocked',evidence:[],steps:[{status:'blocked',evidence:[]}]});
   if(mode==='missing-location')expect(denied.report.diagnostics.map((value:{message:string})=>value.message))
    .toContain('Integrated runtime execution requires one explicit absolute installed package directory.');
   retained.set(resolve(denied.output,'report.json'),readFileSync(resolve(denied.output,'report.json')));
   for(const [root,bytes]of order)expect(readFileSync(resolve(root,'.treeseed/order')),mode).toEqual(bytes);
   writeFileSync(helper,helperBytes);writeFileSync(archive,archiveBytes);
  }
  const retry=invoke('installed-integrated-exact-retry');expect(retry.child.status,retry.child.stdout).toBe(0);
  const retried=(retry.report.results[0].evidence as string[]).filter(path=>path.includes('prerequisite-'));
  expect(retried).toHaveLength(2);
  for(const root of [source,reviewerSource])expect(readFileSync(resolve(root,'.treeseed/order'),'utf8').trim().split('\n').sort())
   .toEqual(['integration','integration','unit','unit']);
  for(const [path,bytes]of retained)expect(readFileSync(path)).toEqual(bytes);
 }catch(error){originalFailure=error;throw error;}
 finally{try{if(installationRoot){rmSync(installationRoot,{recursive:true,force:true});expect(existsSync(installationRoot)).toBe(false);}
  expect(performance.now(),'ACCEPTANCE_INSTALLED_CLOSE: Original thirty-second boundary includes scoped cleanup').toBeLessThan(deadline);
 }catch(cleanupFailure){throw originalFailure?new AggregateError([originalFailure,cleanupFailure],'Original installed proof and scoped cleanup both failed'):cleanupFailure;}}
});

it('reuses integrity checked native production dependency cache without registry revalidation or install scripts',async()=>{
 const root=mkdtempSync(resolve(tmpdir(),'reviewer-native-install-cache-'));roots.push(root);
 const deadline=performance.now()+30_000,workDeadline=deadline-5_000,execute=promisify(execFile);
 const server=createServer();let metadataRequests=0,archiveRequests=0,unexpectedRequests=0,originalFailure:unknown;
 try {
  const source=resolve(root,'source');mkdirSync(source);
  writeFileSync(resolve(source,'package.json'),JSON.stringify({name:'native-cached-owner',version:'1.0.0',files:['payload.txt'],scripts:{install:'node -e "process.exit(97)"'}}));
  writeFileSync(resolve(source,'payload.txt'),'exact cached production archive bytes');
  const pack=native('PACK','npm',['pack','--ignore-scripts','--json','--pack-destination',root],source,workDeadline);
  expect(pack.status).toBe(0);const entries=JSON.parse(pack.stdout) as {filename:string}[];expect(entries).toHaveLength(1);
  const archive=readFileSync(resolve(root,entries[0]!.filename));
  const integrity='sha512-'+createHash('sha512').update(archive).digest('base64');let origin='';
  server.on('request',(request,response)=>{
   if(request.url==='/native-cached-owner') {
    metadataRequests+=1;response.setHeader('Content-Type','application/json');response.setHeader('Cache-Control','public, max-age=0');
    response.end(JSON.stringify({name:'native-cached-owner','dist-tags':{latest:'1.0.0'},versions:{'1.0.0':{name:'native-cached-owner',version:'1.0.0',
     scripts:{install:'node -e "process.exit(97)"'},dist:{tarball:origin+'/native-cached-owner.tgz',integrity}}}}));
   } else if(request.url==='/native-cached-owner.tgz') {archiveRequests+=1;response.setHeader('Cache-Control','public, max-age=31536000');response.end(archive);}
   else {unexpectedRequests+=1;response.statusCode=404;response.end();}
  });
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const address=server.address();expect(address&&typeof address!=='string').toBe(true);
  if(!address||typeof address==='string')throw new Error('ACCEPTANCE_INSTALLED_CACHE_REGISTRY: Loopback native registry unavailable');
  origin='http://127.0.0.1:'+address.port;
  const observations=[];
  for(const mode of ['cold','cached']) {
   const prefix=resolve(root,mode);mkdirSync(prefix);writeFileSync(resolve(prefix,'package.json'),JSON.stringify({private:true}));
   const before={metadataRequests,archiveRequests},remaining=Math.floor(workDeadline-performance.now());expect(remaining).toBeGreaterThan(0);
   const flags=mode==='cold'?productionInstallFlags.filter((flag:string)=>flag!=='--prefer-offline'):productionInstallFlags;
   await execute('npm',['install','--prefix',prefix,...flags,'--registry',origin,'--cache',resolve(root,'cache'),'--update-notifier=false','native-cached-owner@^1.0.0'],
    {cwd:root,encoding:'utf8',timeout:remaining,killSignal:'SIGKILL',maxBuffer:8*1024*1024});
   expect(readFileSync(resolve(prefix,'node_modules/native-cached-owner/payload.txt'),'utf8')).toBe('exact cached production archive bytes');
   expect(JSON.parse(readFileSync(resolve(prefix,'node_modules/native-cached-owner/package.json'),'utf8'))).toMatchObject({name:'native-cached-owner',version:'1.0.0'});
   observations.push({metadata:metadataRequests-before.metadataRequests,archives:archiveRequests-before.archiveRequests});
  }
  expect(observations[0]!.metadata).toBeGreaterThan(0);expect(observations[0]!.archives).toBeGreaterThan(0);
  expect(observations[1],'ACCEPTANCE_INSTALLED_CACHE_REVALIDATION: Fresh independent installation must reuse integrity checked cached dependency').toEqual({metadata:0,archives:0});
  expect(unexpectedRequests).toBe(0);
 } catch(error) {originalFailure=error;throw error;}
 finally {
  try {
   server.closeAllConnections();if(server.listening)await new Promise<void>(resolve=>server.close(()=>resolve()));
   rmSync(root,{recursive:true,force:true});expect(existsSync(root)).toBe(false);
   expect(performance.now(),'ACCEPTANCE_INSTALLED_CACHE_CLOSE: Original thirty-second boundary includes server and installation cleanup').toBeLessThan(deadline);
  } catch(cleanupFailure) {throw originalFailure?new AggregateError([originalFailure,cleanupFailure],'Original native cache proof and cleanup both failed'):cleanupFailure;}
 }
});

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
 expect(existsSync(resolve(installed,'@treeseed/ui')),
  'ACCEPTANCE_INSTALLED_BUILD_DEPENDENCY: Presentation build tooling must not enter production installation').toBe(false);
 const ui=ts.transpileModule(`import assert from 'node:assert/strict';import{readFileSync}from'node:fs';import{resolve}from'node:path';
 import{startReviewerServer}from'@treeseed/reviewer/server';
 const app=await startReviewerServer({workspaceRoot:${JSON.stringify(workspace)},port:0});
 try{const response=await fetch(app.url);assert.equal(response.status,200);const html=await response.text();
 assert.equal(html,readFileSync(resolve(app.context.uiRoot,'index.html'),'utf8'));
 const assets=[...html.matchAll(/(?:src|href)="([^\"]+\\.(?:js|css))"/g)];assert.ok(assets.length>0);
 for(const asset of assets){const response=await fetch(new URL(asset[1],app.url));assert.equal(response.status,200);
 assert.deepEqual(Buffer.from(await response.arrayBuffer()),readFileSync(resolve(app.context.uiRoot,asset[1].replace(/^\\/+/,''))));}}
 finally{app.server.closeAllConnections();await app.close();}`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
 const served=native('HTTP',process.execPath,['--input-type=module','-e',ui],installationRoot,workDeadline);
 expect(served.status,'ACCEPTANCE_INSTALLED_UI: Public installed server must serve exact archived UI without build dependencies').toBe(0);
 const foreign=resolve(installationRoot,'uninstalled-commands');mkdirSync(foreign);
 writeFileSync(resolve(foreign,'fixture-installed-command'),ts.transpileModule("#!/usr/bin/env node\nprocess.stdout.write('uninstalled source fallback');",{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText);
 chmodSync(resolve(foreign,'fixture-installed-command'),0o755);vi.stubEnv('PATH',foreign+delimiter+(process.env.PATH??''));
 writeFileSync(resolve(foreign,'fixture-bundled-command'),readFileSync(resolve(foreign,'fixture-installed-command')));chmodSync(resolve(foreign,'fixture-bundled-command'),0o755);
 const command=resolve(installed,'.bin/treeseed-reviewer-guarantees');
 const planned=native('PLAN',command,['--workspace',workspace,'--ids','proof','--plan','--installed-packages',installed],installationRoot,workDeadline);
 expect(planned.error).toBeUndefined();expect(planned.status,planned.stderr+planned.stdout).toBe(0);
 expect(planned.stdout.trim(),'Installed npm command must emit its actual plan').not.toBe('');
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
