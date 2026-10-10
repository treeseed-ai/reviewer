import { expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { runOwnedCommand } from '../../../src/verifiers/guarantees/owned-command.ts';

it('native action preparation observes the original pinned Elixir OTP and SDK manifest without replacing an active toolchain or changing held assets',()=>{
 const root=mkdtempSync(resolve(tmpdir(),'reviewer-action-native-prerequisites-')),output=resolve(root,'output');
 const files=['package.json','.github/actions/run-scenes/action.yml'],held=files.map(path=>readFileSync(path));
 try{
  writeFileSync(output,'retained=true\n');
  const result=runOwnedCommand(process.execPath,['--import','tsx','scripts/scene-action-prerequisites.ts'],{
   cwd:process.cwd(),encoding:'utf8',timeout:15_000,maxBuffer:8*1024*1024,env:{...process.env,GITHUB_OUTPUT:output}});
  expect(result.error).toBeUndefined();expect(result.signal).toBeNull();expect(result.status,result.stderr).toBe(0);
  const source=JSON.parse(held[0]!.toString('utf8')).dependencies['@treeseed/sdk'].split('#')[1];
  expect(readFileSync(output,'utf8')).toBe(`retained=true\nsdk-commit=${source}\ntoolchain-ready=true\n`);
  for(const [index,path] of files.entries())expect(readFileSync(path)).toEqual(held[index]);
 }finally{rmSync(root,{recursive:true,force:true});expect(existsSync(root)).toBe(false);}
});
