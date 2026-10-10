import { expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';

type Result={status:number|null;signal:NodeJS.Signals|null;stdout:string;stderr:string;error?:NodeJS.ErrnoException};
const load=()=>import(pathToFileURL(resolve('scripts/scene-action-prerequisites.ts')).href) as Promise<{prepareSceneAction:(root:string,execute?:()=>Result,env?:NodeJS.ProcessEnv)=>{sdkCommit:string;toolchainReady:boolean}}>;
it('derives one SDK artifact identity and reuses only the positively measured exact declared native toolchain',async()=>{
 const {prepareSceneAction}=await load(),root=mkdtempSync(resolve(tmpdir(),'reviewer-action-prerequisites-'));
 const action=parse(readFileSync('.github/actions/run-scenes/action.yml','utf8')),manifest=JSON.parse(readFileSync('package.json','utf8'));
 const success:Result={status:0,signal:null,stdout:'1.17.3\n27.3.4.18\n',stderr:''};let calls=0;
 const probe=()=>{calls++;return success;};
 try{
  mkdirSync(resolve(root,'.github/actions/run-scenes'),{recursive:true});
  const save=()=>{writeFileSync(resolve(root,'package.json'),JSON.stringify(manifest));writeFileSync(resolve(root,'.github/actions/run-scenes/action.yml'),JSON.stringify(action));};save();
  const commit=manifest.dependencies['@treeseed/sdk'].split('#')[1];
  expect(prepareSceneAction(root,probe,{})).toEqual({sdkCommit:commit,toolchainReady:true});expect(calls).toBe(1);
  const missing:Result={status:null,signal:null,stdout:'',stderr:'',error:Object.assign(new Error('missing'),{code:'ENOENT'})};
  expect(prepareSceneAction(root,()=>missing,{})).toEqual({sdkCommit:commit,toolchainReady:false});
  expect(()=>prepareSceneAction(root,()=>missing,{INSTALL_DIR_FOR_OTP:'/existing/toolchain'})).toThrow();
  for(const result of [{...success,status:1},{...success,signal:'SIGTERM' as const},{...success,error:Object.assign(new Error('unreadable'),{code:'EACCES'})},
   {...success,stdout:'1.17.3\n27.3.4.19\n'},{...success,stdout:'1.18.0\n27.3.4.18\n'},{...success,stdout:''},{...success,stdout:success.stdout+'extra\n'}])
   expect(()=>prepareSceneAction(root,()=>result,{})).toThrow();
  expect(()=>prepareSceneAction(root,()=>missing,{INSTALL_DIR_FOR_ELIXIR:'/existing/toolchain'})).toThrow();
  const tool=action.runs.steps.find((step:{uses?:string})=>step.uses==='erlef/setup-beam@v1');
  const pins={...tool.with};
  for(const field of ['otp-version','elixir-version'])for(const value of [undefined,27,'', 'latest', '27.3']){
   tool.with={...pins,[field]:value};save();const before=calls;
   expect(()=>prepareSceneAction(root,probe,{})).toThrow();expect(calls).toBe(before);
  }
  tool.with=pins;action.runs.steps.push({...tool});save();const before=calls;
  expect(()=>prepareSceneAction(root,probe,{})).toThrow();expect(calls).toBe(before);
  action.runs.steps.pop();save();
  for(const value of ['', 'latest','git+https://github.com/treeseed-ai/sdk.git#staging','git+https://github.com/treeseed-ai/sdk.git#'+'A'.repeat(40)]){
   manifest.dependencies['@treeseed/sdk']=value;save();const before=calls;expect(()=>prepareSceneAction(root,probe,{})).toThrow();expect(calls).toBe(before);
  }
 }finally{rmSync(root,{recursive:true,force:true});}
});
