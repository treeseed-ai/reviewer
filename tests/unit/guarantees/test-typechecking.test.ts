import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import ts from 'typescript';

it('requires strict checking of every actual test source in the complete verification command', () => {
  const config = ts.readConfigFile('tsconfig.json', ts.sys.readFile);
  expect(config.error).toBeUndefined();
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, '.');
  expect(parsed.errors).toEqual([]);
  expect(parsed.options.strict).toBe(true);
  const tests = ts.sys.readDirectory('.', ['.ts'], ['node_modules', 'dist', '.treeseed'], ['tests/**/*.ts']);
  expect(tests.length).toBeGreaterThan(0);
  expect(tests.filter(file => !parsed.fileNames.includes(file))).toEqual([]);
  const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
  expect(manifest.scripts.typecheck).toBe('tsc --noEmit -p tsconfig.json');
  expect(manifest.scripts.verify.split(' && ')).toContain('npm run typecheck');
});
