import{expect,it}from'vitest';
import{spawnSync}from'node:child_process';
import{mkdtempSync,writeFileSync,readFileSync,rmSync,existsSync}from'node:fs';
import{tmpdir}from'node:os';
import{resolve}from'node:path';

it('native named Node assertions preserve original owner failure classification and code through denial repeated runs and raw-output redaction',()=>{
 const root=mkdtempSync(resolve(tmpdir(),'reviewer-owner-failure-code-')),runner=resolve(import.meta.dirname,'../../../src/verifiers/guarantees/node-case.ts'),loader=resolve(import.meta.dirname,'../../../node_modules/tsx/dist/loader.mjs'),testFile=resolve(root,'owner.test.ts');
 const observations:Array<{expected:string;actual:unknown;status:number|null}>=[];
 try{
  for(const[metadata,expected]of[
   [{classification:'OWNER_REQUIRES_REVIEW',code:'OWNER_NATIVE_FAILURE'},'OWNER_REQUIRES_REVIEW'],
   [{code:'OWNER_NATIVE_FAILURE'},'OWNER_NATIVE_FAILURE'],
   [{classification:'private\ncredential-bearing-prose',code:'OWNER_NATIVE_FAILURE'},'OWNER_NATIVE_FAILURE'],
   [{classification:'private\ncredential-bearing-prose',code:'sk-private-secret'},'ERR_TEST_FAILURE'],
   [{},'ERR_TEST_FAILURE'],
  ]as const){
   const source="import test from 'node:test';test('original owner failure',()=>{console.log('PRIVATE_OWNER_STDOUT');console.error('PRIVATE_OWNER_STDERR');throw Object.assign(new Error('PRIVATE_OWNER_MESSAGE'),"+JSON.stringify(metadata)+");});\n";writeFileSync(testFile,source);const bytes=readFileSync(testFile);
   for(let attempt=0;attempt<2;attempt++){
    const result=spawnSync(process.execPath,['--import',loader,runner,testFile,'original owner failure'],{cwd:root,encoding:'utf8',timeout:5_000,maxBuffer:1024*1024});expect(result.error).toBeUndefined();expect(result.signal).toBeNull();expect(result.status).toBe(1);
    const report=JSON.parse(result.stdout),checks=report.testResults[0].assertionResults;expect(report.success).toBe(false);expect(report.numFailedTests).toBe(1);expect(report.numPassedTests).toBe(0);expect(checks).toHaveLength(1);expect(checks[0].title).toBe('original owner failure');expect(checks[0].status).toBe('failed');expect(Number.isFinite(checks[0].duration)&&checks[0].duration>=0).toBe(true);
    expect.soft(checks[0].failure.code).toBe(expected);for(const privateValue of['PRIVATE_OWNER_STDOUT','PRIVATE_OWNER_STDERR','PRIVATE_OWNER_MESSAGE','private-secret','credential-bearing-prose']){expect(result.stdout).not.toContain(privateValue);expect(result.stderr).not.toContain(privateValue);}
    expect(readFileSync(testFile)).toEqual(bytes);observations.push({expected,actual:checks[0].failure.code,status:result.status});
   }
  }expect(observations).toHaveLength(10);
 }finally{rmSync(root,{recursive:true,force:true});}
 expect(existsSync(root)).toBe(false);
},30_000);
