import { afterEach, expect, it } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { fixture, roots } from '../../fixtures/guarantee-prerequisites.ts';
import { planLocalGuarantees, runLocalGuarantees } from '../../../src/verifiers/guarantees/command.ts';

afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});

it('blocks missing installed owner custody before source suites or source scene fallback',()=>{
 const root=fixture();
 const report=runLocalGuarantees(root,planLocalGuarantees(root,['proof']),'missing-installed',resolve(root,'missing-install/node_modules'));
 expect(report.ok).toBe(false);
 expect(report.results[0]!.steps.every(step=>step.status==='blocked')).toBe(true);
 expect(existsSync(resolve(root,'.treeseed/order'))).toBe(false);
 expect(report.diagnostics!.some(diagnostic=>diagnostic.message.includes('Installed'))).toBe(true);
});
