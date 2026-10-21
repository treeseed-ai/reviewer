import { afterEach, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { planLocalGuarantees, runLocalGuarantees } from '../../src/verifiers/guarantees/command.ts';
import { candidate } from '../../src/verifiers/guarantees/prerequisites.ts';
import { fixture, roots } from '../fixtures/guarantee-prerequisites.ts';

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it('retains safe process output when every Vitest assertion passes but the owning process exits nonzero', () => {
	const root = fixture();
	writeFileSync(resolve(root, 'vitest.config.ts'), `process.on('beforeExit',()=>{console.error('Error: runtime ended at /home/private/project; TOKEN=private-value');process.exitCode=1;}); export default {test:{include:["tests/**/*.test.ts"]}};`);
	const before = candidate(root), plan = planLocalGuarantees(root, ['proof']);
	const report = runLocalGuarantees(root, plan, 'passed-assertions-nonzero-process');
	expect(report.ok).toBe(false);
	const receipt = JSON.parse(readFileSync(resolve(root, '.treeseed/guarantees/runs/passed-assertions-nonzero-process', report.results[0]!.evidence.at(-1)!), 'utf8'));
	expect(receipt).toMatchObject({ ...before, passed: false, exitCode: 1, signal: null,
		checks: { total: 2, passed: 2, failed: 0, skipped: 0, todo: 0 } });
	expect(receipt.failureEvidence.processOutput.join('\n')).toContain('runtime ended at [PATH]');
	expect(JSON.stringify(receipt.failureEvidence)).not.toMatch(/private-value|\/home\/private/);
	expect(existsSync(resolve(root, 'node_modules/.cache'))).toBe(false);
	expect(candidate(root)).toEqual(before);
});

for (const mode of ['malformed', 'missing'] as const) it(`retains process evidence and removes temporary reports after a ${mode} Vitest report`, () => {
	const root = fixture();
	const launcher = resolve(root, 'node_modules/vitest/vitest.mjs'); unlinkSync(launcher);
	writeFileSync(launcher, `import {writeFileSync} from 'node:fs'; const output=process.argv.find(value=>value.startsWith('--outputFile=')); console.error('Error: suite runtime failed at /private/fixture TOKEN=private-value'); ${mode === 'malformed' ? "if(output)writeFileSync(output.slice('--outputFile='.length),'{');" : ''} process.exitCode=1;`);
	const before = new Set(readdirSync(tmpdir()).filter(name => name.startsWith('guarantee-vitest-suite-')));
	const report = runLocalGuarantees(root, planLocalGuarantees(root, ['proof']), `report-${mode}`);
	expect(report.ok).toBe(false);
	const receipt = JSON.parse(readFileSync(resolve(root, `.treeseed/guarantees/runs/report-${mode}`, report.results[0]!.evidence.at(-1)!), 'utf8'));
	expect(receipt).toMatchObject({passed:false, exitCode:1, signal:null});
	expect(receipt.failureEvidence.processOutput.join('\n')).toContain('suite runtime failed at [PATH]');
	expect(JSON.stringify(receipt.failureEvidence)).not.toMatch(/private-value|\/private\/fixture/);
	expect(readdirSync(tmpdir()).filter(name => name.startsWith('guarantee-vitest-suite-') && !before.has(name))).toEqual([]);
});
