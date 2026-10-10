import { afterEach, expect, it } from 'vitest';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fixture, roots } from '../../fixtures/guarantee-prerequisites.ts';
import { planLocalGuarantees, runLocalGuarantees } from '../../../src/verifiers/guarantees/command.ts';

afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
it('native missing public module collection retains its exact owning file and blocks scenes despite every collected assertion passing',()=>{
 const root=fixture();writeFileSync(resolve(root,'tests/unavailable.test.ts'),"import '@fixture/missing-native-public-package';");
 const report=runLocalGuarantees(root,planLocalGuarantees(root,['proof']),'native-collection-denied');
 expect(report.ok).toBe(false);expect(readFileSync(resolve(root,'.treeseed/order'),'utf8')).not.toContain('scene');
 const path=report.results[0]!.evidence.find(path=>path.includes('prerequisite-'))!;
 const receipt=JSON.parse(readFileSync(resolve(root,'.treeseed/guarantees/runs/native-collection-denied',path),'utf8'));
 expect(receipt).toMatchObject({passed:false,exitCode:1,checks:{total:2,passed:2,failed:0,skipped:0,todo:0,
  failures:[{file:'tests/unavailable.test.ts',status:'collection_failed'}]}});
 expect(existsSync(resolve(root,'tests/unavailable.test.ts'))).toBe(true);
});
