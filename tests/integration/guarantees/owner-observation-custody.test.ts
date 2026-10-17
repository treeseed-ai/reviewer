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
  const report=runLocalGuarantees(root,plan,runId);expect(report.ok).toBe(true);const output=resolve(root,'.treeseed/guarantees/runs',runId),path=resolve(output,'evidence',createHash('sha256').update(id).digest('hex')+'.observations.json'),bytes=readFileSync(path);
  expect(JSON.parse(bytes.toString('utf8'))).toEqual({original:'public-owner-observation',failed:false});expect(report.results[0]!.evidence).toContain(relative(output,path));const receipt=JSON.parse(readFileSync(resolve(output,'evidence',createHash('sha256').update(id).digest('hex')+'.json'),'utf8'));
  expect(receipt).toMatchObject({verifierId:id,testName:name,passed:true,observationSha256:createHash('sha256').update(bytes).digest('hex')});expect(receipt.checks).toHaveLength(1);expect(existsSync(forged)).toBe(false);snapshots.push(bytes);
 }
 expect(snapshots[0]).toEqual(snapshots[1]);expect(readFileSync(resolve(root,'.treeseed/order'),'utf8').trim().split('\n').sort()).toEqual(['integration','integration','unit','unit'].sort());
});
