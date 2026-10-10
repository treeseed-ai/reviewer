import { afterEach, expect, it } from 'vitest';
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fixture, roots } from '../../fixtures/guarantee-prerequisites.ts';
import { planLocalGuarantees, runLocalGuarantees } from '../../../src/verifiers/guarantees/command.ts';
import { runOwnedCommand } from '../../../src/verifiers/guarantees/owned-command.ts';

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it('native complete suites cannot leave a live owned descendant behind a passing report or continue into scenes', async () => {
  const root = fixture(), pidFile = resolve(root, '.treeseed/descendant.pid');
  writeFileSync(resolve(root, 'timed.ts'), `import{spawn}from'node:child_process';
const child=spawn(process.execPath,['-e','setInterval(()=>{},100)'],{stdio:'ignore'});child.unref();setInterval(()=>{},100);`);
  const timed = runOwnedCommand(process.execPath, ['timed.ts'], { cwd: root, encoding: 'utf8', timeout: 500, maxBuffer: 1_024 });
  expect(timed.error).toMatchObject({ code: 'ETIMEDOUT' });
  expect(timed.error).toBeInstanceOf(AggregateError);
  expect(timed.signal).toBe('SIGKILL');
  writeFileSync(resolve(root, 'descendant.ts'), `import {writeFileSync} from 'node:fs';
writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000);`);
  appendFileSync(resolve(root, 'tests/integration.test.ts'), `
import {spawn} from 'node:child_process';import {existsSync} from 'node:fs';
it('original native descendant',async()=>{const child=spawn(process.execPath,['descendant.ts'],{stdio:'ignore'});child.unref();
const deadline=Date.now()+2000;while(!existsSync(${JSON.stringify(pidFile)})){expect(Date.now()).toBeLessThan(deadline);await new Promise(resolve=>setTimeout(resolve,10));}});`);
  let pid: number | undefined;
  try {
    const report = runLocalGuarantees(root, planLocalGuarantees(root, ['proof']), 'owned-process-custody');
    expect(existsSync(pidFile)).toBe(true); pid = Number(readFileSync(pidFile, 'utf8')); expect(Number.isSafeInteger(pid)).toBe(true);
    expect(report.ok).toBe(false);
    expect(readFileSync(resolve(root, '.treeseed/order'), 'utf8')).not.toContain('scene');
    const receiptPath = report.results[0]!.evidence.find(path => path.includes('prerequisite-'))!;
    const receipt = JSON.parse(readFileSync(resolve(root, '.treeseed/guarantees/runs/owned-process-custody', receiptPath), 'utf8'));
    expect(receipt.passed).toBe(false); expect(receipt.checks).toMatchObject({ total: 3, passed: 3, failed: 0, skipped: 0, todo: 0 });
    expect(() => process.kill(pid!, 0)).toThrow(/ESRCH/u);
  } finally {
    if (pid === undefined && existsSync(pidFile)) pid = Number(readFileSync(pidFile, 'utf8'));
    if (pid !== undefined) {
      try { process.kill(pid, 'SIGKILL'); } catch (error) { expect((error as NodeJS.ErrnoException).code).toBe('ESRCH'); }
      const deadline = Date.now() + 2_000;
      for (;;) {
        try { process.kill(pid, 0); } catch (error) { expect((error as NodeJS.ErrnoException).code).toBe('ESRCH'); break; }
        expect(Date.now()).toBeLessThan(deadline); await new Promise(accept => setTimeout(accept, 10));
      }
    }
  }
});

it('native selected verifier residue is closed and blocks later scenes while an unrelated owned group remains live', async () => {
  const root = fixture(), pidFile = resolve(root, '.treeseed/selected.pid');
  writeFileSync(resolve(root, 'descendant.ts'), `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000);`);
  writeFileSync(resolve(root, 'unrelated.ts'), `import{writeFileSync}from'node:fs';writeFileSync('.treeseed/unrelated.pid',String(process.pid));setInterval(()=>{},1000);`);
  writeFileSync(resolve(root, 'scene.ts'), `import test from 'node:test';import assert from 'node:assert/strict';import{spawn}from'node:child_process';import{existsSync}from'node:fs';
test('scene boundary',async()=>{const child=spawn(process.execPath,['descendant.ts'],{stdio:'ignore'});child.unref();
const deadline=Date.now()+2000;while(!existsSync(${JSON.stringify(pidFile)})){assert.ok(Date.now()<deadline);await new Promise(resolve=>setTimeout(resolve,10));}});`);
  writeFileSync(resolve(root, 'after.ts'), `import test from 'node:test';import{writeFileSync}from'node:fs';test('after boundary',()=>writeFileSync('.treeseed/after','must remain blocked'));`);
  writeFileSync(resolve(root, 'guarantees/proof.guarantee.yaml'), 'id: proof\nscene: {required: true, manifest: guarantees/proof.scene.yaml}\n');
  writeFileSync(resolve(root, 'guarantees/proof.scene.yaml'), JSON.stringify({ scope: 'local-component-tests', workflow: [
    { id: 'original', action: { verifier: 'proof.scene' }, expect: { status: 'passed' } },
    { id: 'after', action: { verifier: 'proof.after' }, expect: { status: 'passed' } },
  ] }));
  appendFileSync(resolve(root, 'guarantees/proof.verifiers.yaml'), '  proof.after: {kind: nodeTestCase, ownerPackage: fixture, testFile: after.ts, testName: after boundary}\n');
  const sibling = spawn(process.execPath, ['unrelated.ts'], { cwd: root, detached: true, stdio: 'ignore' });
  let pid: number | undefined;
  try {
    const deadline = Date.now() + 2_000;
    while (!existsSync(resolve(root, '.treeseed/unrelated.pid'))) {
      expect(Date.now()).toBeLessThan(deadline); await new Promise(accept => setTimeout(accept, 10));
    }
    const report = runLocalGuarantees(root, planLocalGuarantees(root, ['proof']), 'selected-process-custody');
    expect(existsSync(pidFile)).toBe(true); pid = Number(readFileSync(pidFile, 'utf8'));
    expect(report.ok).toBe(false); expect(report.results[0]!.steps.map(step => step.status)).toEqual(['failed', 'blocked']);
    const evidence = report.results[0]!.steps[0]!.evidence![0]!;
    const receipt = JSON.parse(readFileSync(resolve(root, '.treeseed/guarantees/runs/selected-process-custody', evidence), 'utf8'));
    expect(receipt).toMatchObject({ passed: false, exitCode: 0, processErrorCode: 'VERIFIER_SUBPROCESS_RESIDUE', checks: [{ status: 'passed' }] });
    expect(existsSync(resolve(root, '.treeseed/after'))).toBe(false); expect(() => process.kill(pid!, 0)).toThrow(/ESRCH/u);
    expect(() => process.kill(sibling.pid!, 0)).not.toThrow();
  } finally {
    if (pid === undefined && existsSync(pidFile)) pid = Number(readFileSync(pidFile, 'utf8'));
    if (pid !== undefined) try { process.kill(pid, 'SIGKILL'); } catch (error) { expect((error as NodeJS.ErrnoException).code).toBe('ESRCH'); }
    if (sibling.exitCode === null && sibling.signalCode === null) {
      process.kill(-sibling.pid!, 'SIGKILL'); await new Promise<void>(accept => sibling.once('close', () => accept()));
    }
    expect(() => process.kill(sibling.pid!, 0)).toThrow(/ESRCH/u);
  }
});
