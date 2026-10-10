import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { runOwnedCommand } from '../../../src/verifiers/guarantees/owned-command.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const fixture = () => { const root = mkdtempSync(resolve(tmpdir(), 'reviewer-owned-command-')); roots.push(root); return root; };

it('preserves native outputs literal arguments nonzero exits and unavailable commands without relaxing original bounds', () => {
  const root = fixture(), options = { cwd: root, encoding: 'utf8' as const, timeout: 2_000, maxBuffer: 1_024 };
  writeFileSync(resolve(root, 'command.ts'), `process.stdout.write('λ'+process.argv[2]);process.stderr.write('original stderr');process.exitCode=7;`);
  const literal = '$(touch unauthorized-command)', result = runOwnedCommand(process.execPath, ['command.ts', literal], options);
  expect(result).toMatchObject({ status: 7, signal: null, stdout: `λ${literal}`, stderr: 'original stderr' }); expect(result.error).toBeUndefined();
  expect(runOwnedCommand(resolve(root, 'missing'), [], options).error).toMatchObject({ code: 'ENOENT' });
  for (const timeout of [undefined, 0, -1, Number.NaN, 1.5])
    expect(() => runOwnedCommand(process.execPath, ['command.ts'], { ...options, timeout })).toThrow('original positive');
});

it('kills only its original timed-out or overflowing native command and retains the original failure classification', () => {
  const root = fixture(), options = { cwd: root, encoding: 'utf8' as const, timeout: 500, maxBuffer: 1_024 };
  writeFileSync(resolve(root, 'timeout.ts'), `import{writeFileSync}from'node:fs';writeFileSync('command.pid',String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},100);`);
  const timed = runOwnedCommand(process.execPath, ['timeout.ts'], options);
  expect(timed.error).toMatchObject({ code: 'ETIMEDOUT' }); expect(timed.signal).toBe('SIGKILL');
  const pid = Number(readFileSync(resolve(root, 'command.pid'), 'utf8')); expect(() => process.kill(pid, 0)).toThrow(/ESRCH/u);
  writeFileSync(resolve(root, 'output.ts'), `process.stdout.write('x'.repeat(4096));setInterval(()=>{},100);`);
  const overflow = runOwnedCommand(process.execPath, ['output.ts'], options); expect(overflow.error).toMatchObject({ code: 'ENOBUFS' });
  expect(overflow.signal).toBe('SIGKILL'); expect(() => process.kill(overflow.pid, 0)).toThrow(/ESRCH/u);
  writeFileSync(resolve(root, 'timeout-descendant.ts'), `import{spawn}from'node:child_process';import{existsSync}from'node:fs';
const child=spawn(process.execPath,['-e',"require('node:fs').writeFileSync('descendant.pid',String(process.pid));setInterval(()=>{},100)"],{stdio:'ignore'});child.unref();
while(!existsSync('descendant.pid'))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);setInterval(()=>{},100);`);
  const descendant = runOwnedCommand(process.execPath, ['timeout-descendant.ts'], options);
  expect(descendant.error).toMatchObject({ code: 'ETIMEDOUT' });
  expect(descendant.error).toBeInstanceOf(AggregateError);
  expect((descendant.error as AggregateError).errors.some(error => error.code === 'VERIFIER_SUBPROCESS_RESIDUE')).toBe(true);
  expect(descendant.signal).toBe('SIGKILL');
});

it('rejects an unsupported process-group host before launching an unowned native command', () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  try {
    Object.defineProperty(process, 'platform', { ...descriptor, value: 'win32' });
    expect(() => runOwnedCommand(process.execPath, [], { encoding: 'utf8', timeout: 500 })).toThrow('custody is unavailable');
  } finally { Object.defineProperty(process, 'platform', descriptor); }
});
