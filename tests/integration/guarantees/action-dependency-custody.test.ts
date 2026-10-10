import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';
import { candidate } from '../../../src/verifiers/guarantees/prerequisites.ts';
import { runOwnedCommand } from '../../../src/verifiers/guarantees/owned-command.ts';

it('native disabled Git dependency scripts cannot supply archived public exports until an actual built package is installed',()=>{
 const deadline=performance.now()+30_000,workDeadline=deadline-5_000;
 const root=mkdtempSync(resolve(tmpdir(),'reviewer-action-dependency-'));let originalFailure:unknown;
 const native=(phase:string,command:string,args:string[],cwd=root)=>{
  const timeout=Math.floor(workDeadline-performance.now());expect(timeout,phase).toBeGreaterThan(0);
  const result=runOwnedCommand(command,args,{cwd,encoding:'utf8',timeout,maxBuffer:8*1024*1024});
  expect(result.error,phase).toBeUndefined();expect(result.signal,phase).toBeNull();return result;
 };
 try {
  const action=parse(readFileSync('.github/actions/run-scenes/action.yml','utf8'));
  const step=action.runs.steps.find((value:{uses?:string})=>value.uses?.startsWith('treeseed-ai/sdk/.github/actions/install-exact-sdk@'));
  expect(step?.with.paths).toBe('.treeseed/tools/reviewer/node_modules/@treeseed/sdk');
  const source=resolve(root,'source'),prefix=resolve(root,'.treeseed/tools/reviewer');mkdirSync(source);mkdirSync(prefix,{recursive:true});
  const marker='actual compiled public fixture bytes',compiled=`export const value=${JSON.stringify(marker)};\n`;
  writeFileSync(resolve(source,'package.json'),JSON.stringify({name:'@treeseed/sdk',version:'0.0.0-fixture',type:'module',files:['dist'],
   exports:{'./operator-contracts':'./dist/operator-contracts.js'},scripts:{prepare:'node build.ts',build:'node build.ts'}}));
  writeFileSync(resolve(source,'.gitignore'),'dist/\n*.tgz\nnode_modules/\n');
  writeFileSync(resolve(source,'build.ts'),`import{mkdirSync,writeFileSync}from'node:fs';mkdirSync('dist',{recursive:true});writeFileSync('dist/operator-contracts.js',${JSON.stringify(compiled)});\n`);
  for(const args of [['init','--quiet'],['add','.'],['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--quiet','-m','Exact native dependency']])
   expect(native('fixture Git candidate','git',args,source).status).toBe(0);
  const held=candidate(source),url=`git+${pathToFileURL(source).href}#${held.commit}`;
  const install=(input:string)=>native('scripts-disabled native install','npm',['install','--prefix',prefix,'--omit=dev','--ignore-scripts','--package-lock=false','--no-save','--no-audit','--no-fund',input]);
  const first=install(url);expect(first.status,first.stderr).toBe(0);
  const installed=resolve(root,step.with.paths),asset=resolve(installed,'dist/operator-contracts.js');
  expect(existsSync(resolve(installed,'package.json'))).toBe(true);expect(existsSync(asset)).toBe(false);
  const read=()=>native('actual public export',process.execPath,['--input-type=module','-e',"import{value}from'@treeseed/sdk/operator-contracts';process.stdout.write(value)"],prefix);
  const denied=read();expect(denied.status).toBe(1);expect(denied.stderr).toContain('ERR_MODULE_NOT_FOUND');
  expect(native('original owning build','npm',['run','build'],source).status).toBe(0);
  const packed=native('actual native archive','npm',['pack','--ignore-scripts','--json','--pack-destination',root],source);
  expect(packed.status,packed.stderr).toBe(0);const archive=resolve(root,JSON.parse(packed.stdout)[0].filename);
  const digest=createHash('sha256').update(readFileSync(archive)).digest('hex');
  const replacement=install(archive);expect(replacement.status,replacement.stderr).toBe(0);
  const accepted=read();expect(accepted.status,accepted.stderr).toBe(0);expect(accepted.stdout).toBe(marker);
  expect(readFileSync(asset,'utf8')).toBe(compiled);expect(candidate(source)).toEqual(held);
  expect(createHash('sha256').update(readFileSync(archive)).digest('hex')).toBe(digest);
  expect(denied.status).toBe(1);expect(denied.stderr).toContain('ERR_MODULE_NOT_FOUND');
 } catch(error) {originalFailure=error;throw error;}
 finally {
  try {rmSync(root,{recursive:true,force:true});expect(existsSync(root)).toBe(false);
   expect(performance.now(),'Original thirty-second native boundary includes scoped cleanup').toBeLessThan(deadline);
  } catch(cleanupFailure) {throw originalFailure?new AggregateError([originalFailure,cleanupFailure],'Original native dependency and cleanup both failed'):cleanupFailure;}
 }
});
