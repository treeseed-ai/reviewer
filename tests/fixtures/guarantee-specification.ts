import { mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, cpSync, mkdtempSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { expect } from 'vitest';
import type { GuaranteeRunReport } from '@treeseed/sdk/guarantees';
import type { LocalGuaranteePlan } from '../../src/verifiers/guarantees/command.ts';

// Package inputs only: the real installed command, Vitest and Git own execution.
// Missing declared dist bytes fail; this fixture never builds or installs them.
export function specificationFixture() {
  const repository = resolve(import.meta.dirname, '../..');
  const packagePath = resolve(repository, 'package.json');
  const packageBytes = readFileSync(packagePath);
  const manifest: { bin: Record<string, string> } = JSON.parse(packageBytes.toString('utf8'));
  expect(manifest.bin['treeseed-reviewer-guarantees']).toBe('./dist/verifiers/guarantees/command.js');
  const bin = resolve(repository, manifest.bin['treeseed-reviewer-guarantees']!);
  const binBytes = readFileSync(bin);
  const root = mkdtempSync(resolve(tmpdir(), 'reviewer-whole-spec-'));
  try {
    for (const directory of ['tests', 'guarantees/verifiers', '.treeseed']) mkdirSync(resolve(root, directory), { recursive: true });
    // Reuse the existing native prerequisite fixture's owned-launcher pattern.
    // The original command's path fence must never be bypassed for selected tests.
    mkdirSync(resolve(root, 'node_modules/vitest'), { recursive: true });
    cpSync(resolve(repository, 'node_modules/vitest/vitest.mjs'), resolve(root, 'node_modules/vitest/vitest.mjs'));
    symlinkSync(resolve(repository, 'node_modules/vitest/dist'), resolve(root, 'node_modules/vitest/dist'), 'dir');
    const specification = '# Specification\n\n## Required outcomes\n- Source bytes remain exact.\n- Native readback matches source bytes.\n';
    const criterion = (text: string) => createHash('sha256').update(`Specification / Required outcomes\n${text}`).digest('hex');
    const contracts = [
      { id: 'proof.unit', criterion: criterion('- Source bytes remain exact.'), ref: 'proof.unit', file: 'tests/unit.test.ts', name: 'source bytes remain exact' },
      { id: 'proof.native', criterion: criterion('- Native readback matches source bytes.'), ref: 'proof.native', file: 'tests/integration.test.ts', name: 'native readback matches source bytes' },
    ];
    const sourceBytes = Buffer.from(' exact native source é\n', 'utf8');
    const files = new Map<string, Buffer>();
    const put = (path: string, value: string | Buffer) => { const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value); files.set(path, bytes); writeFileSync(resolve(root, path), bytes); };
    put('.gitignore', 'node_modules\n.treeseed\n');
    put('package.json', JSON.stringify({ name: '@fixture/spec', type: 'module', scripts: { test: 'vitest run --config ./vitest.config.ts' } }));
    put('vitest.config.ts', "export default {test:{include:['tests/**/*.test.ts'],fileParallelism:false,maxWorkers:1}};\n");
    put('treeseed.package.yaml', JSON.stringify({ development: { project: { id: 'specification-fixture' }, targets: [{ id: 'runtime', dependencies: [] }] } }));
    put('acceptance.md', specification);
    put('source.txt', sourceBytes);
    put('tests/unit.test.ts', "import {test,expect} from 'vitest'; import {readFileSync,appendFileSync} from 'node:fs'; test('source bytes remain exact',()=>{expect(readFileSync('source.txt')).toEqual(Buffer.from(' exact native source é\\n','utf8'));appendFileSync('.treeseed/observations','unit\\n');});\n");
    put('tests/integration.test.ts', "import {test,expect} from 'vitest'; import {readFileSync,writeFileSync,appendFileSync,existsSync} from 'node:fs'; test('native readback matches source bytes',()=>{appendFileSync('.treeseed/observations','native\\n');expect(existsSync('.treeseed/failure')).toBe(false);const bytes=readFileSync('source.txt');writeFileSync('.treeseed/readback',bytes);expect(readFileSync('.treeseed/readback')).toEqual(bytes);});\n");
    const verifiers: Record<string, unknown> = {};
    for (const contract of contracts) {
      put(`guarantees/${contract.id}.guarantee.yaml`, JSON.stringify({ id: contract.id, ownerPackage: '@fixture/spec',
        acceptanceCriteria: [{ criterion: contract.criterion, verifierRefs: [contract.ref] }],
        scene: { required: true, manifest: `guarantees/${contract.id}.scene.yaml` } }));
      put(`guarantees/${contract.id}.scene.yaml`, JSON.stringify({ scope: 'local-component-tests', workflow: [
        { id: contract.id, action: { verifier: contract.ref }, expect: { status: 'passed' } },
      ] }));
      verifiers[contract.ref] = { kind: 'vitestCase', ownerPackage: '@fixture/spec', testFile: contract.file, testName: contract.name };
    }
    put('guarantees/verifiers/spec.verifiers.yaml', JSON.stringify({ verifiers }));
    for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Exact specification fixture']])
      expect(spawnSync('git', args, { cwd: root, encoding: 'utf8' }).status).toBe(0);
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
    expect(head.status).toBe(0);
    const invoke = (runId: string, ids = 'proof.unit,proof.native', plan = false, sections: string[] = [], exactSections: string[] = []) => {
      const args = [bin, '--workspace', root, '--ids', ids, '--acceptance-spec', 'acceptance.md', '--run-id', runId, ...(plan ? ['--plan'] : []), ...sections.flatMap(section => ['--acceptance-section', section]), ...exactSections.flatMap(section => ['--acceptance-exact-section', section])];
      const before = [...args];
      const child = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
      expect(child.error).toBeUndefined(); expect(child.signal).toBeNull(); expect(child.stderr, child.stderr).toBe('');
      expect(args).toEqual(before);
      expect(child.stdout.trim().split('\n')).toHaveLength(1);
      const report: LocalGuaranteePlan | GuaranteeRunReport = JSON.parse(child.stdout);
      expect(report.ok).toBe(child.status === 0);
      return { child, report };
    };
    return { root, files, specification, contracts, verifiers, invoke,
      restore: () => { for (const [path, bytes] of files) writeFileSync(resolve(root, path), bytes); },
      close: () => {
        try {
          expect(readFileSync(packagePath)).toEqual(packageBytes); expect(readFileSync(bin)).toEqual(binBytes);
          const current = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
          expect(current.status).toBe(0); expect(current.stdout).toBe(head.stdout);
        } finally { rmSync(root, { recursive: true, force: true }); }
      },
    };
  } catch (error) { rmSync(root, { recursive: true, force: true }); throw error; }
}
