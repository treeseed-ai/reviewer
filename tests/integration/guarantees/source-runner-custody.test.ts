import { afterEach, expect, it } from 'vitest';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fixture, roots } from '../../fixtures/guarantee-prerequisites.ts';
import { sourceRunnerFixture } from '../../fixtures/source-runner.ts';

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it('native source CLI runs its executing Reviewer complete suite beside the selected owner before every scene and retains failed runner coverage before fresh retry', () => {
	const owner = fixture(), runner = sourceRunnerFixture(), loader = resolve(import.meta.dirname, '../../../node_modules/tsx/dist/loader.mjs');
	const invoke = (id: string) => {
		const native = spawnSync(process.execPath, ['--import', loader, resolve(runner, 'src/verifiers/guarantees/command.ts'),
			'--workspace', owner, '--ids', 'proof', '--environment', 'local', '--run-id', id], { encoding: 'utf8', timeout: 15_000 });
		expect(native.error).toBeUndefined(); expect(native.signal).toBeNull();
		const output = resolve(owner, '.treeseed/guarantees/runs', id), report = JSON.parse(native.stdout);
		const receipts = report.results[0].evidence.filter((path: string) => path.includes('prerequisite-'))
			.map((path: string) => JSON.parse(readFileSync(resolve(output, path), 'utf8')));
		return { native, report, receipts, bytes: readFileSync(resolve(output, 'report.json')) };
	};
	const passed = invoke('source-runner-first'); expect(passed.report.ok).toBe(true); expect(passed.native.status).toBe(0);
	expect(passed.receipts.map((value: { root: string }) => value.root).sort()).toEqual([owner, runner].sort());
	for (const receipt of passed.receipts) expect(receipt).toMatchObject({ passed: true, checks: { total: 2, passed: 2, failed: 0, skipped: 0, todo: 0 } });
	const unit = resolve(runner, 'tests/unit.test.ts'), original = readFileSync(unit, 'utf8');
	writeFileSync(unit, original.replace('expect(false)', 'expect(true)'));
	const failed = invoke('source-runner-failed'); expect(failed.report.ok).toBe(false); expect(failed.native.status).toBe(1);
	expect(failed.receipts.find((value: { root: string }) => value.root === runner)).toMatchObject({ passed: false, checks: { total: 2, passed: 1, failed: 1, skipped: 0, todo: 0 } });
	expect(readFileSync(resolve(owner, '.treeseed/order'), 'utf8').split('\n').filter(value => value === 'scene')).toHaveLength(1);
	writeFileSync(unit, original); const retry = invoke('source-runner-retry'); expect(retry.report.ok).toBe(true);
	expect(retry.receipts.map((value: { root: string }) => value.root).sort()).toEqual([owner, runner].sort());
	expect(readFileSync(resolve(owner, '.treeseed/guarantees/runs/source-runner-first/report.json'))).toEqual(passed.bytes);
	expect(readFileSync(resolve(owner, '.treeseed/guarantees/runs/source-runner-failed/report.json'))).toEqual(failed.bytes);
	expect(readFileSync(resolve(runner, '.treeseed/order'), 'utf8').split('\n').filter(Boolean).sort()).toEqual(['integration', 'integration', 'integration', 'unit', 'unit', 'unit']);
}, 30_000);
