import { expect, it } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';

it('native composite source capture retains the exact Reviewer commit across nested action context and denies invalid refs before checkout', () => {
  const source = process.cwd(), root = mkdtempSync(resolve(tmpdir(), 'reviewer-action-source-'));
  const action = parse(readFileSync(resolve(source, '.github/actions/run-scenes/action.yml'), 'utf8'));
  const preparation = action.runs.steps[0] as { id: string; run: string };
  const checkout = action.runs.steps.find((step: { uses?: string }) => step.uses === 'actions/checkout@v4');
  const git = (cwd: string, args: string[]) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 5_000 });
    expect(result.error).toBeUndefined(); expect(result.signal).toBeNull(); return result;
  };
  const commit = git(source, ['rev-parse', 'HEAD']).stdout.trim();
  const capture = (ref: string, index: number) => {
    const output = resolve(root, `output-${index}`); writeFileSync(output, '');
    const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', preparation.run], {
      cwd: root, encoding: 'utf8', timeout: 5_000,
      env: { ...process.env, REVIEWER_REF: ref, GITHUB_OUTPUT: output },
    });
    expect(result.error).toBeUndefined(); expect(result.signal).toBeNull();
    return { result, output: readFileSync(output, 'utf8') };
  };
  try {
    mkdirSync(resolve(root, 'node_modules'));
    const held = capture(commit, 0); expect(held.result.status).toBe(0);
    expect(held.output).toBe(`ref=${commit}\n`);
    expect(preparation.id).toBe('reviewer-source');
    expect(checkout.with.ref).toBe('${{ steps.reviewer-source.outputs.ref }}');
    // actions/checkout has its own action_ref=v4. Its input must use the
    // already captured caller ref, whose actual Git bytes are checked below.
    const nestedActionRef = 'v4', captured = held.output.slice(4).trim();
    expect(captured).not.toBe(nestedActionRef);
    const destination = resolve(root, '.treeseed/tools/reviewer'); mkdirSync(destination, { recursive: true });
    expect(git(destination, ['init', '--quiet']).status).toBe(0);
    expect(git(destination, ['fetch', '--quiet', '--depth=1', source, captured]).status).toBe(0);
    expect(git(destination, ['checkout', '--quiet', '--detach', 'FETCH_HEAD']).status).toBe(0);
    expect(git(destination, ['rev-parse', 'HEAD']).stdout.trim()).toBe(commit);
    expect(readFileSync(resolve(destination, 'package.json'))).toEqual(readFileSync(resolve(source, 'package.json')));
    expect(existsSync(resolve(destination, 'dist'))).toBe(false);
    symlinkSync(resolve(source, 'node_modules'), resolve(destination, 'node_modules'), 'dir');
    const build = action.runs.steps.find((step: { name: string }) => step.name === 'Build the executing Reviewer archive assets');
    if (build) {
      const built = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', build.run], {
        cwd: root, encoding: 'utf8', timeout: 15_000, maxBuffer: 8 * 1024 * 1024,
      });
      expect(built.error).toBeUndefined(); expect(built.signal).toBeNull(); expect(built.status, built.stderr).toBe(0);
    }
    const inventory = spawnSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], {
      cwd: destination, encoding: 'utf8', timeout: 5_000,
    });
    expect(inventory.error).toBeUndefined(); expect(inventory.status, inventory.stderr).toBe(0);
    const paths = JSON.parse(inventory.stdout)[0].files.map((file: { path: string }) => file.path);
    for (const path of ['dist/verifiers/guarantees/command.js', 'dist/verifiers/guarantees/node-case.js']) expect(paths).toContain(path);
    writeFileSync(resolve(root, 'consumer.ts'), `import assert from 'node:assert/strict';
import {planLocalGuarantees,runLocalGuarantees} from './.treeseed/tools/reviewer/dist/verifiers/guarantees/command.js';
assert.equal(typeof planLocalGuarantees,'function');assert.equal(typeof runLocalGuarantees,'function');`);
    const loaded = spawnSync(process.execPath, ['consumer.ts'], { cwd: root, encoding: 'utf8', timeout: 5_000 });
    expect(loaded.error).toBeUndefined(); expect(loaded.status, loaded.stderr).toBe(0);
    expect(git(destination, ['status', '--porcelain']).stdout).toBe('');
    rmSync(resolve(root, '.treeseed'), { recursive: true });
    for (const [index, ref] of ['', 'v4', 'staging', 'a'.repeat(39), 'a'.repeat(41), 'A'.repeat(40), `${commit}\nref=staging`].entries()) {
      const denied = capture(ref, index + 1); expect(denied.result.status).not.toBe(0); expect(denied.output).toBe('');
    }
    mkdirSync(resolve(root, '.treeseed/tools/reviewer'), { recursive: true });
    const occupied = capture(commit, 20); expect(occupied.result.status).not.toBe(0); expect(occupied.output).toBe('');
    expect(readFileSync(resolve(root, 'output-0'), 'utf8')).toBe(held.output);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
