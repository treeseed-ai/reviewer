import {afterEach,expect,it,vi} from 'vitest';
import {writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {resolve,relative} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fixture,roots} from '../../fixtures/guarantee-prerequisites.ts';
import {planLocalGuarantees,runLocalGuarantees} from '../../../src/verifiers/guarantees/command.ts';
afterEach(()=>{vi.unstubAllEnvs();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
it('retains explicit owner observations only in the current native run bundle while preserving complete prerequisites failed assertions and caller path denial',()=>{
 const root=fixture(),forged=resolve(root,'caller-forged.json'),name='scene boundary',id='proof.scene';
 const source="import test from 'node:test';import assert from 'node:assert/strict';import {writeFileSync,readFileSync} from 'node:fs';test('scene boundary',()=>{const path=process.env.TREESEED_GUARANTEE_OBSERVATION_PATH;assert.ok(path);assert.match(path,/\\/evidence\\/[a-f0-9]{64}\\.observations\\.json$/u);const order=readFileSync('.treeseed/order','utf8').trim().split('\\n');assert.ok(order.includes('unit')&&order.includes('integration'));writeFileSync(path,JSON.stringify({original:'public-owner-observation',failed:false}),{flag:'wx',mode:0o400});console.log('PRIVATE_OWNER_STDOUT');});\n";
 writeFileSync(resolve(root,'scene.ts'),source);expect(spawnSync('git',['add','.'],{cwd:root}).status).toBe(0);expect(spawnSync('git',['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','Owner observation'],{cwd:root}).status).toBe(0);
 vi.stubEnv('TREESEED_GUARANTEE_OBSERVATION_PATH',forged);const plan=planLocalGuarantees(root,['proof']),snapshots:Buffer[]=[];
 for(const runId of ['first','fresh']){
  const report=runLocalGuarantees(root,plan,runId);expect(report.diagnostics).toEqual([]);const receiptRoot=resolve(root,'.treeseed/guarantees/runs',runId);const prerequisite=JSON.parse(readFileSync(resolve(receiptRoot,report.results[0]!.evidence.at(-1)!),'utf8'));expect(prerequisite).toMatchObject({passed:true,checks:{total:2,passed:2,failed:0,skipped:0,todo:0}});if(!report.ok){const failed=JSON.parse(readFileSync(resolve(receiptRoot,'evidence',createHash('sha256').update(id).digest('hex')+'.json'),'utf8'));expect(failed.checks).toHaveLength(1);expect(failed.checks[0].failure.code).toBe('ERR_ASSERTION');}expect(report.ok).toBe(true);const output=resolve(root,'.treeseed/guarantees/runs',runId),path=resolve(output,'evidence',createHash('sha256').update(id).digest('hex')+'.observations.json'),bytes=readFileSync(path);
  expect(JSON.parse(bytes.toString('utf8'))).toEqual({original:'public-owner-observation',failed:false});expect(report.results[0]!.evidence).toContain(relative(output,path));const receipt=JSON.parse(readFileSync(resolve(output,'evidence',createHash('sha256').update(id).digest('hex')+'.json'),'utf8'));
  expect(receipt).toMatchObject({verifierId:id,testName:name,passed:true,observationSha256:createHash('sha256').update(bytes).digest('hex')});expect(receipt.checks).toHaveLength(1);expect(existsSync(forged)).toBe(false);snapshots.push(bytes);
 }
 expect(snapshots[0]).toEqual(snapshots[1]);expect(readFileSync(resolve(root,'.treeseed/order'),'utf8').trim().split('\n').sort()).toEqual(['integration','integration','unit','unit'].sort());
});

function ownerCase(observation:string,tail:string){
 const root=fixture(),path=resolve(root,'scene.ts'),source="import test from 'node:test';import assert from 'node:assert/strict';import {writeFileSync,readFileSync} from 'node:fs';test('scene boundary',()=>{const path=process.env.TREESEED_GUARANTEE_OBSERVATION_PATH;assert.ok(path);const order=readFileSync('.treeseed/order','utf8').trim().split('\\n');assert.ok(order.includes('unit')&&order.includes('integration'));writeFileSync(path,"+JSON.stringify(observation)+",{flag:'wx',mode:0o400});console.log('PRIVATE_OWNER_STDOUT');console.error('PRIVATE_OWNER_STDERR');"+tail+"});\n";
 writeFileSync(path,source);expect(spawnSync('git',['add','.'],{cwd:root}).status).toBe(0);expect(spawnSync('git',['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','Original failed owner observation'],{cwd:root}).status).toBe(0);
 return root;
}
it('native failed owner assertions retain original observation digests and failure classification through fresh repeated invocations without leaking subprocess prose',()=>{
 const original='{"original":"retained public failure","failed":true}\n',root=ownerCase(original,"throw Object.assign(new Error('PRIVATE_OWNER_MESSAGE'),{classification:'OWNER_REQUIRES_REVIEW'});"),plan=planLocalGuarantees(root,['proof']),hash=createHash('sha256').update('proof.scene').digest('hex'),prior:Array<{path:string;bytes:Buffer}>=[];
 for(const runId of ['failed-first','failed-fresh']){
  const report=runLocalGuarantees(root,plan,runId),output=resolve(root,'.treeseed/guarantees/runs',runId),receipt=JSON.parse(readFileSync(resolve(output,'evidence',hash+'.json'),'utf8')),path=resolve(output,'evidence',hash+'.observations.json'),bytes=readFileSync(path);
  expect(report.ok).toBe(false);expect(report.counts.failed).toBe(1);expect(receipt).toMatchObject({passed:false,observationSha256:createHash('sha256').update(bytes).digest('hex')});expect(receipt.checks).toHaveLength(1);expect(receipt.checks[0]).toMatchObject({status:'failed',failure:{code:'OWNER_REQUIRES_REVIEW'}});expect(bytes.toString('utf8')).toBe(original);
  expect(report.results[0]!.evidence).toContain(relative(output,path));const prerequisite=JSON.parse(readFileSync(resolve(output,report.results[0]!.evidence.at(-1)!),'utf8'));expect(prerequisite).toMatchObject({passed:true,checks:{total:2,passed:2,failed:0,skipped:0,todo:0}});
  for(const secret of ['PRIVATE_OWNER_STDOUT','PRIVATE_OWNER_STDERR','PRIVATE_OWNER_MESSAGE'])expect(JSON.stringify({report,receipt})).not.toContain(secret);
  for(const retained of prior)expect(readFileSync(retained.path)).toEqual(retained.bytes);prior.push({path,bytes});
 }
 expect(readFileSync(resolve(root,'.treeseed/order'),'utf8').trim().split('\\n').sort()).toEqual(['integration','integration','unit','unit'].sort());
});
it('native passing owner assertions fail custody when their explicit observation is malformed without inventing an observation digest or passing receipt',()=>{
 const original='{"truncated":',root=ownerCase(original,''),plan=planLocalGuarantees(root,['proof']),report=runLocalGuarantees(root,plan,'malformed-owner'),output=resolve(root,'.treeseed/guarantees/runs/malformed-owner'),hash=createHash('sha256').update('proof.scene').digest('hex'),path=resolve(output,'evidence',hash+'.observations.json'),receipt=JSON.parse(readFileSync(resolve(output,'evidence',hash+'.json'),'utf8'));
 expect(report.ok).toBe(false);expect(report.counts.failed).toBe(1);expect(receipt.passed).toBe(false);expect(receipt.checks).toHaveLength(1);expect(receipt.checks[0].status).toBe('passed');expect(receipt).not.toHaveProperty('observationSha256');expect(receipt.diagnostics).not.toEqual([]);expect(report.results[0]!.evidence).not.toContain(relative(output,path));expect(readFileSync(path,'utf8')).toBe(original);
 const prerequisite=JSON.parse(readFileSync(resolve(output,report.results[0]!.evidence.at(-1)!),'utf8'));expect(prerequisite).toMatchObject({passed:true,checks:{total:2,passed:2,failed:0,skipped:0,todo:0}});
});
