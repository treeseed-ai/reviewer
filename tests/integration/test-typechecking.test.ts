import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import ts from 'typescript';

it('native TypeScript includes and checks the entire owning test inventory without changing candidate inputs', () => {
  const tests = ts.sys.readDirectory('.', ['.ts'], ['node_modules', 'dist', '.treeseed'], ['tests/**/*.ts']);
  expect(tests.length).toBeGreaterThan(0);
  const inputs = ['tsconfig.json', 'package.json', ...tests].map(path => [path, readFileSync(path)] as const);
  const compiler = resolve('node_modules/typescript/bin/tsc');
  const listing = spawnSync(process.execPath, [compiler, '--showConfig', '-p', 'tsconfig.json'], { encoding: 'utf8', timeout: 15_000 });
  expect(listing.error).toBeUndefined(); expect(listing.signal).toBeNull(); expect(listing.status).toBe(0);
  const config = JSON.parse(listing.stdout);
  expect(config.compilerOptions.strict).toBe(true);
  const represented = new Set<string>(config.files.map((file: string) => resolve(file)));
  expect(tests.filter(file => !represented.has(resolve(file)))).toEqual([]);
  const checked = spawnSync(process.execPath, [compiler, '--noEmit', '-p', 'tsconfig.json'], { encoding: 'utf8', timeout: 15_000 });
  expect(checked.error).toBeUndefined(); expect(checked.signal).toBeNull(); expect(checked.status, checked.stdout + checked.stderr).toBe(0);
  for (const [path, bytes] of inputs) expect(readFileSync(path)).toEqual(bytes);
});
