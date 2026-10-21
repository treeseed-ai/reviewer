import { afterEach, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { planLocalGuarantees, runLocalGuarantees } from '../../src/verifiers/guarantees/command.ts';
import { candidate } from '../../src/verifiers/guarantees/prerequisites.ts';
import { fixture, privateVitestLauncher, roots } from '../fixtures/guarantee-prerequisites.ts';

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const installedLauncher = resolve(import.meta.dirname, '../../node_modules/vitest/vitest.mjs');
const installedBytes = () => readFileSync(installedLauncher);

it('retains safe process output when all assertions pass but the owning process exits nonzero', () => {
	const root = fixture();
	writeFileSync(resolve(root, 'vitest.config.ts'), `process.on('exit',()=>{console.error('Error: runtime ended at /home/private/project; TOKEN=private-value');process.exitCode=1;}); export default {test:{include:["tests/**/*.test.ts"]}};`);
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

it('leaves successful prerequisite receipts without failure-only process evidence', () => {
	const root = fixture();
	const report = runLocalGuarantees(root, planLocalGuarantees(root, ['proof']), 'successful-prerequisite');
	expect(report.ok).toBe(true);
	const receipt = JSON.parse(readFileSync(resolve(root, '.treeseed/guarantees/runs/successful-prerequisite', report.results[0]!.evidence.at(-1)!), 'utf8'));
	expect(receipt.passed).toBe(true);
	expect(receipt).not.toHaveProperty('failureEvidence');
});

for (const mode of ['malformed', 'missing'] as const) it(`owns the ${mode} report launcher and preserves installed Vitest`, () => {
	const originalRunner = installedBytes();
	const root = fixture();
	const launcher = privateVitestLauncher(root, `import {writeFileSync} from 'node:fs'; const output=process.argv.find(value=>value.startsWith('--outputFile=')); console.error('Error: suite runtime failed at /private/fixture TOKEN=private-value'); ${mode === 'malformed' ? "if(output)writeFileSync(output.slice('--outputFile='.length),'{');" : ''} process.exitCode=1;`);
	expect(statSync(resolve(root, 'node_modules/vitest')).isDirectory()).toBe(true);
	expect(launcher.startsWith(resolve(root, 'node_modules/vitest'))).toBe(true);
	const before = new Set(readdirSync(tmpdir()).filter(name => name.startsWith('guarantee-vitest-suite-')));
	const report = runLocalGuarantees(root, planLocalGuarantees(root, ['proof']), `report-${mode}`);
	expect(report.ok).toBe(false);
	const receipt = JSON.parse(readFileSync(resolve(root, `.treeseed/guarantees/runs/report-${mode}`, report.results[0]!.evidence.at(-1)!), 'utf8'));
	expect(receipt).toMatchObject({passed:false, exitCode:1, signal:null});
	expect(receipt.failureEvidence.processOutput.join('\n')).toContain('suite runtime failed at [PATH]');
	expect(JSON.stringify(receipt.failureEvidence)).not.toMatch(/private-value|\/private\/fixture/);
	expect(readdirSync(tmpdir()).filter(name => name.startsWith('guarantee-vitest-suite-') && !before.has(name))).toEqual([]);
	expect(installedBytes().equals(originalRunner)).toBe(true);
	const ordinary = fixture();
	const ordinaryResult = spawnSync(process.execPath, [installedLauncher, 'run', '--api.host', '127.0.0.1', '--config', resolve(ordinary, 'vitest.config.ts')],
		{ cwd: ordinary, encoding: 'utf8' });
	expect(ordinaryResult.status, ordinaryResult.stderr).toBe(0);
	expect(readFileSync(resolve(ordinary, '.treeseed/order'), 'utf8').trim().split('\n').sort()).toEqual(['integration', 'unit']);
	expect(installedBytes().equals(originalRunner)).toBe(true);
});
