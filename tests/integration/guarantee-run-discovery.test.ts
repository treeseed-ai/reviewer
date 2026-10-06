import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { commandArgsForGuarantees, discoverGuaranteeRuns, loadGuaranteeReviewRun } from '../../src/server/guarantee-runs.ts';
import type { GuaranteeRunReport } from '@treeseed/sdk/guarantees';
import type { LocalGuaranteePlan } from '../../src/verifiers/guarantees/command.ts';

// Package inputs only: the real installed command, Vitest and Git own execution.
// Missing declared dist bytes fail; this fixture never builds or installs them.
function specificationFixture() {
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
    symlinkSync(resolve(repository, 'node_modules'), resolve(root, 'node_modules'), 'dir');
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
    const invoke = (runId: string, ids = 'proof.unit,proof.native', plan = false) => {
      const args = [bin, '--workspace', root, '--ids', ids, '--acceptance-spec', 'acceptance.md', '--run-id', runId, ...(plan ? ['--plan'] : [])];
      const before = [...args];
      const child = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
      expect(child.error).toBeUndefined(); expect(child.signal).toBeNull(); expect(child.stderr).toBe('');
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

function fixtureReport(overrides: Partial<GuaranteeRunReport> = {}): GuaranteeRunReport {
  return {
    ok: false,
    runId: 'run-a',
    workspaceRoot: '/tmp/workspace',
    environment: 'local',
    filter: { ownerPackage: '@treeseed/admin', status: 'active' },
    startedAt: '2026-07-08T10:00:00.000Z',
    completedAt: '2026-07-08T10:01:00.000Z',
    outputRoot: '.treeseed/guarantees/runs/run-a',
    plan: {
      ok: true,
      workspaceRoot: '/tmp/workspace',
      filter: {},
      environment: 'local',
      entries: [{
        id: 'guarantee.reviewer.workplan.create-local-workplan.001',
        type: 'reviewer',
        subtype: 'workplan',
        journey: 'Create local workplan',
        ownerPackage: '@treeseed/reviewer',
        status: 'active',
        gates: ['core'],
        sourcePath: 'packages/reviewer/guarantees/reviewer/workplan/create-local-workplan.guarantee.yaml',
        selected: true,
        dependency: false,
        apiVerifierRefs: [],
        contentVerifierRefs: [],
        auditVerifierRefs: [],
        evidenceRequired: ['screenshot'],
        sceneManifest: 'scenes/create-local-workplan.scene.yaml',
      }],
      diagnostics: [],
      counts: { total: 1, selected: 1, withDependencies: 1, errors: 0, warnings: 0 },
    },
    results: [{
      id: 'guarantee.reviewer.workplan.create-local-workplan.001',
      type: 'reviewer',
      subtype: 'workplan',
      journey: 'Create local workplan',
      ownerPackage: '@treeseed/reviewer',
      status: 'failed',
      selected: true,
      dependency: false,
      sourcePath: 'packages/reviewer/guarantees/reviewer/workplan/create-local-workplan.guarantee.yaml',
      startedAt: '2026-07-08T10:00:01.000Z',
      completedAt: '2026-07-08T10:00:02.000Z',
      steps: [{
        id: 'scene',
        kind: 'scene',
        status: 'failed',
        summary: 'Screenshot mismatch',
        evidence: ['evidence/screenshot.png', 'logs/console.log'],
        diagnostics: [{ severity: 'error', code: 'scene.failed', message: 'Button is not visible.' }],
      }],
      evidence: ['evidence/screenshot.png'],
      diagnostics: [{ severity: 'error', code: 'guarantee.scene_execution_failed', message: 'Scene failed.' }],
    }],
    diagnostics: [],
    counts: { planned: 0, passed: 0, failed: 1, skipped: 0, blocked: 0, releaseBlockingFailures: 0 },
    ...overrides,
  };
}

function writeRun(root: string, kind: 'runs' | 'release', runId: string, report = fixtureReport({ runId })) {
  const dir = resolve(root, '.treeseed', 'guarantees', kind, runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(resolve(dir, 'plan.json'), `${JSON.stringify(report.plan, null, 2)}\n`);
  return dir;
}

describe('guarantee run discovery', () => {
  it('extracted native Reviewer archive preserves declared bytes and whole specification denial before fresh complete execution', () => {
    const repository = resolve(import.meta.dirname, '../..');
    const manifest: { name: string; version: string; files: string[]; bin: Record<string, string> } = JSON.parse(readFileSync(resolve(repository, 'package.json'), 'utf8'));
    expect(manifest.files).toEqual(['README.md', 'dist', 'treeseed.package.yaml']); expect(manifest.bin['treeseed-reviewer-guarantees']).toBe('./dist/verifiers/guarantees/command.js');
    const bytes = new Map<string, Buffer>();
    const capture = (path: string) => {
      if (path === 'dist') {
        const walk = (directory: string) => {
          for (const entry of readdirSync(resolve(repository, directory), { withFileTypes: true })) {
            const member = `${directory}/${entry.name}`; if (entry.isDirectory()) walk(member);
            else { expect(entry.isFile()).toBe(true); bytes.set(member, readFileSync(resolve(repository, member))); }
          }
        };
        walk(path);
      } else bytes.set(path, readFileSync(resolve(repository, path)));
    };
    for (const path of ['package.json', 'LICENSE', ...manifest.files]) capture(path);
    expect(bytes.has('dist/verifiers/guarantees/command.js')).toBe(true); expect(bytes.has('dist/verifiers/guarantees/node-case.js')).toBe(true);
    const archiveRoot = mkdtempSync(resolve(tmpdir(), 'reviewer-extracted-spec-'));
    try {
      const native = (command: string, args: string[], cwd: string) => {
        const child = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
        expect(child.error).toBeUndefined(); expect(child.signal).toBeNull(); return child;
      };
      // Consume the held build without running prepack, building or installing.
      const packed = native('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', archiveRoot], repository);
      expect(packed.status).toBe(0); const records: Array<{ name: string; version: string; filename: string; files: Array<{ path: string }> }> = JSON.parse(packed.stdout);
      expect(records).toHaveLength(1);
      const record = records[0]!; expect([record.name, record.version]).toEqual([manifest.name, manifest.version]);
      expect(record.filename).toMatch(/^[a-zA-Z0-9_.-]+\.tgz$/); expect(record.files.map(file => file.path).sort()).toEqual([...bytes.keys()].sort());
      const archive = resolve(archiveRoot, record.filename), archiveBytes = readFileSync(archive);
      expect(native('tar', ['-xzf', archive, '-C', archiveRoot], archiveRoot).status).toBe(0);
      const extracted = resolve(archiveRoot, 'package'); for (const [path, value] of bytes) expect(readFileSync(resolve(extracted, path))).toEqual(value);
      // Dependency resolution only; no source command or installed-dependency closure claim.
      symlinkSync(resolve(repository, 'node_modules'), resolve(extracted, 'node_modules'), 'dir');
      const fixture = specificationFixture();
      try {
        const invoke = (runId: string, plan: boolean, ids = 'proof.unit,proof.native') => {
          const args = [resolve(extracted, manifest.bin['treeseed-reviewer-guarantees']!), '--workspace', fixture.root, '--ids', ids, '--acceptance-spec', 'acceptance.md', '--run-id', runId, ...(plan ? ['--plan'] : [])];
          const before = [...args], child = native(process.execPath, args, fixture.root);
          expect(args).toEqual(before); expect(child.stderr).toBe(''); expect(child.stdout.trim().split('\n')).toHaveLength(1);
          const report: LocalGuaranteePlan | GuaranteeRunReport = JSON.parse(child.stdout);
          expect(report.ok).toBe(child.status === 0); return { child, report };
        };
        expect(invoke('archive-complete-plan', true).report.ok).toBe(true);
        const mutations = [
          () => writeFileSync(resolve(fixture.root, 'acceptance.md'), `${fixture.specification}\n- Another exact outcome is required.\n`),
          () => writeFileSync(resolve(fixture.root, 'acceptance.md'), fixture.specification.replace('bytes remain exact', 'bytes may change')),
          () => rmSync(resolve(fixture.root, 'acceptance.md')),
          () => writeFileSync(resolve(fixture.root, 'guarantees/verifiers/spec.verifiers.yaml'), JSON.stringify({ verifiers: {} })),
          () => {},
        ];
        const failed = new Map<string, Buffer>();
        for (const [index, mutate] of mutations.entries()) {
          fixture.restore(); mutate();
          const ids = index === mutations.length - 1 ? 'proof.unit' : undefined, supplied = [...fixture.files.keys()].filter(path => existsSync(resolve(fixture.root, path))).map(path => [path, readFileSync(resolve(fixture.root, path))] as const);
          const absent = [...fixture.files.keys()].filter(path => !existsSync(resolve(fixture.root, path)));
          for (const plan of [true, false]) {
            const runId = `archive-denied-${index}-${plan}`, denied = invoke(runId, plan, ids);
            expect(denied.child.status).toBe(1); expect(denied.report.diagnostics!.length).toBeGreaterThan(0);
            if (!plan) {
              const report = denied.report as GuaranteeRunReport; expect(report.counts?.passed).toBe(0); expect(report.results.every(result => result.status === 'blocked')).toBe(true);
              expect(report.results.map(result => [result.id, result.status])).toEqual((ids === 'proof.unit' ? ['proof.unit'] : ['proof.unit', 'proof.native']).map(id => [id, 'blocked']));
              expect(report.results.flatMap(result => result.evidence ?? [])).toEqual([]); const path = resolve(fixture.root, '.treeseed/guarantees/runs', runId, 'report.json');
              failed.set(path, readFileSync(path)); expect(JSON.parse(failed.get(path)!.toString('utf8'))).toEqual(report);
            }
          }
          expect(existsSync(resolve(fixture.root, '.treeseed/observations'))).toBe(false);
          for (const [path, value] of supplied) expect(readFileSync(resolve(fixture.root, path))).toEqual(value); for (const path of absent) expect(existsSync(resolve(fixture.root, path))).toBe(false);
        }
        fixture.restore(); const passed = invoke('archive-fresh-complete', false), report = passed.report as GuaranteeRunReport;
        expect(passed.child.status).toBe(0); expect(report.ok).toBe(true); expect(report.scope).toBe('local-component-tests');
        expect(report.results.map(result => [result.id, result.status])).toEqual([['proof.unit', 'passed'], ['proof.native', 'passed']]);
        const output = resolve(fixture.root, '.treeseed/guarantees/runs/archive-fresh-complete'), receipt = report.results[0]!.evidence!.find(path => path.includes('prerequisite-'))!;
        expect(JSON.parse(readFileSync(resolve(output, receipt), 'utf8'))).toMatchObject({ passed: true, exitCode: 0,
          checks: { total: 2, passed: 2, failed: 0, skipped: 0, todo: 0 } });
        for (const contract of fixture.contracts) {
          const result = report.results.find(result => result.id === contract.id)!; expect(result.steps.map(step => [step.id, step.kind, step.status])).toEqual([[contract.ref, 'scene', 'passed']]);
          const evidence = result.evidence!.find(path => !path.includes('prerequisite-'))!;
          expect(JSON.parse(readFileSync(resolve(output, evidence), 'utf8'))).toMatchObject({ verifierId: contract.ref,
            testFile: contract.file, testName: contract.name, passed: true, exitCode: 0, signal: null,
            sourceDigest: createHash('sha256').update(fixture.files.get(contract.file)!).digest('hex') });
        }
        expect(readFileSync(resolve(fixture.root, '.treeseed/observations'), 'utf8').trim().split('\n').sort()).toEqual(['native', 'native', 'unit', 'unit']);
        expect(readFileSync(resolve(fixture.root, '.treeseed/readback'))).toEqual(fixture.files.get('source.txt')); expect(JSON.parse(readFileSync(resolve(output, 'report.json'), 'utf8'))).toEqual(report);
        for (const [path, value] of failed) expect(readFileSync(path)).toEqual(value); for (const [path, value] of fixture.files) expect(readFileSync(resolve(fixture.root, path))).toEqual(value);
      } finally { fixture.close(); }
      expect(readFileSync(archive)).toEqual(archiveBytes);
      for (const [path, value] of bytes) {
        expect(readFileSync(resolve(extracted, path))).toEqual(value); expect(readFileSync(resolve(repository, path))).toEqual(value);
      }
    } finally { rmSync(archiveRoot, { recursive: true, force: true }); }
  });

  it('packaged Reviewer denies new changed missing unbound and partial whole specifications before any native suite or scene', () => {
    const fixture = specificationFixture();
    try {
      const { root, specification, invoke, contracts } = fixture;
      expect(invoke('complete-plan', undefined, true).report.ok).toBe(true);
      expect(existsSync(resolve(root, '.treeseed/guarantees'))).toBe(false);
      const scenarios = [
        () => writeFileSync(resolve(root, 'acceptance.md'), `${specification}\n- Another exact outcome is required.\n`),
        () => writeFileSync(resolve(root, 'acceptance.md'), specification.replace('bytes remain exact', 'bytes may change')),
        () => writeFileSync(resolve(root, 'acceptance.md'), specification.replace('- Source bytes remain exact.\n', '')),
        () => rmSync(resolve(root, 'acceptance.md')),
        () => writeFileSync(resolve(root, 'acceptance.md'), '# Empty\n'),
        () => writeFileSync(resolve(root, 'guarantees/proof.native.guarantee.yaml'), JSON.stringify({ id: 'proof.native', ownerPackage: '@fixture/spec', api: { verifierRefs: ['proof.native'] } })),
        () => writeFileSync(resolve(root, 'guarantees/verifiers/spec.verifiers.yaml'), JSON.stringify({ verifiers: { 'proof.unit': fixture.verifiers['proof.unit'] } })),
        () => rmSync(resolve(root, contracts[1]!.file)),
        () => {},
      ];
      for (const [index, mutate] of scenarios.entries()) {
        fixture.restore(); mutate();
        const ids = index === scenarios.length - 1 ? 'proof.unit' : undefined;
        const before = [...fixture.files.keys()].filter(path => existsSync(resolve(root, path))).map(path => [path, readFileSync(resolve(root, path))] as const);
        const absent = [...fixture.files.keys()].filter(path => !existsSync(resolve(root, path)));
        const planned = invoke(`denied-plan-${index}`, ids, true);
        expect(planned.child.status).toBe(1); expect(planned.report.ok).toBe(false);
        expect(planned.report.diagnostics!.length).toBeGreaterThan(0);
        const denied = invoke(`denied-run-${index}`, ids);
        const report = denied.report as GuaranteeRunReport;
        expect(denied.child.status).toBe(1); expect(report.ok).toBe(false);
        expect(report.counts?.passed).toBe(0);
        expect(report.results.every(result => result.status === 'blocked')).toBe(true);
        expect(report.results.flatMap(result => result.evidence ?? [])).toEqual([]);
        expect(existsSync(resolve(root, '.treeseed/observations'))).toBe(false);
        const run = resolve(root, '.treeseed/guarantees/runs', `denied-run-${index}`);
        expect(JSON.parse(readFileSync(resolve(run, 'report.json'), 'utf8'))).toEqual(report);
        for (const [path, bytes] of before) expect(readFileSync(resolve(root, path))).toEqual(bytes);
        for (const path of absent) expect(existsSync(resolve(root, path))).toBe(false);
      }
      fixture.restore();
      expect(invoke('exact-restored-plan', undefined, true).report.ok).toBe(true);
      expect(existsSync(resolve(root, '.treeseed/observations'))).toBe(false);
    } finally { fixture.close(); }
  });

  it('packaged Reviewer retains a real failed whole-suite observation and admits only a fresh complete exact-specification retry', () => {
    const fixture = specificationFixture();
    try {
      const { root, invoke } = fixture;
      writeFileSync(resolve(root, '.treeseed/failure'), 'controlled failure input');
      const failed = invoke('original-failed');
      const failedReport = failed.report as GuaranteeRunReport;
      expect(failed.child.status).toBe(1); expect(failedReport.ok).toBe(false);
      expect(failedReport.counts?.passed).toBe(0);
      expect(failedReport.results.every(result => result.status === 'blocked')).toBe(true);
      const output = resolve(root, '.treeseed/guarantees/runs/original-failed');
      const failedBytes = readFileSync(resolve(output, 'report.json'));
      const receiptPath = failedReport.results[0]!.evidence!.find(path => path.includes('prerequisite-'))!;
      expect(typeof receiptPath).toBe('string');
      const receiptBytes = readFileSync(resolve(output, receiptPath));
      expect(JSON.parse(receiptBytes.toString('utf8'))).toMatchObject({ passed: false, exitCode: 1,
        checks: { total: 2, passed: 1, failed: 1, skipped: 0, todo: 0,
          failures: [{ title: 'native readback matches source bytes', status: 'failed' }] } });
      expect(readFileSync(resolve(root, '.treeseed/observations'), 'utf8').trim().split('\n').sort()).toEqual(['native', 'unit']);
      rmSync(resolve(root, '.treeseed/failure'));
      const retried = invoke('fresh-complete-retry');
      const report = retried.report as GuaranteeRunReport;
      expect(retried.child.status).toBe(0); expect(report.ok).toBe(true);
      expect(report.scope).toBe('local-component-tests');
      expect(report.results.map(result => [result.id, result.status])).toEqual([['proof.unit', 'passed'], ['proof.native', 'passed']]);
      for (const contract of fixture.contracts) {
        const result = report.results.find(result => result.id === contract.id)!;
        expect(result.steps.map(step => [step.id, step.kind, step.status])).toEqual([[contract.ref, 'scene', 'passed']]);
        const evidence = result.evidence!.find(path => !path.includes('prerequisite-'))!;
        expect(JSON.parse(readFileSync(resolve(root, '.treeseed/guarantees/runs/fresh-complete-retry', evidence), 'utf8')))
          .toMatchObject({ verifierId: contract.ref, testFile: contract.file, testName: contract.name, passed: true,
            exitCode: 0, signal: null, sourceDigest: createHash('sha256').update(fixture.files.get(contract.file)!).digest('hex') });
      }
      expect(readFileSync(resolve(root, '.treeseed/readback'))).toEqual(fixture.files.get('source.txt'));
      expect(readFileSync(resolve(root, '.treeseed/observations'), 'utf8').trim().split('\n').sort()).toEqual(['native', 'native', 'native', 'unit', 'unit', 'unit']);
      const retryOutput = resolve(root, '.treeseed/guarantees/runs/fresh-complete-retry');
      const retryReceipt = report.results[0]!.evidence!.find(path => path.includes('prerequisite-'))!;
      expect(JSON.parse(readFileSync(resolve(retryOutput, retryReceipt), 'utf8'))).toMatchObject({ passed: true, exitCode: 0,
        checks: { total: 2, passed: 2, failed: 0, skipped: 0, todo: 0 } });
      expect(JSON.parse(readFileSync(resolve(retryOutput, 'report.json'), 'utf8'))).toEqual(report);
      expect(readFileSync(resolve(output, 'report.json'))).toEqual(failedBytes);
      expect(readFileSync(resolve(output, receiptPath))).toEqual(receiptBytes);
      for (const [path, bytes] of fixture.files) expect(readFileSync(resolve(root, path))).toEqual(bytes);
    } finally { fixture.close(); }
  });

  it('finds local and release runs and ignores folders without report.json', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'treeseed-reviewer-'));
    writeRun(root, 'runs', 'run-a');
    writeRun(root, 'release', 'run-b', fixtureReport({ runId: 'run-b', startedAt: '2026-07-08T11:00:00.000Z', completedAt: '2026-07-08T11:01:00.000Z' }));
    mkdirSync(resolve(root, '.treeseed/guarantees/runs/not-a-run'), { recursive: true });
    const runs = discoverGuaranteeRuns(root);
    expect(runs.map((run) => run.runId)).toEqual(['run-b', 'run-a']);
    expect(runs[0]?.kind).toBe('release');
  });

  it('normalizes run details and identifies screenshot evidence', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'treeseed-reviewer-'));
    const runDir = writeRun(root, 'runs', 'run-a');
    mkdirSync(resolve(runDir, 'evidence'), { recursive: true });
    mkdirSync(resolve(runDir, 'logs'), { recursive: true });
    writeFileSync(resolve(runDir, 'evidence/screenshot.png'), 'image');
    writeFileSync(resolve(runDir, 'logs/console.log'), 'error');
    const detail = loadGuaranteeReviewRun(root, 'run-a');
    expect(detail.items).toHaveLength(1);
    expect(detail.items[0]?.primaryScreenshot?.kind).toBe('screenshot');
    expect(detail.items[0]?.primaryLog?.kind).toBe('log');
  });

  it('expands scene run directories into screenshot and log evidence', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'treeseed-reviewer-'));
    const runDir = writeRun(root, 'runs', 'run-a', fixtureReport({
      results: [{
        ...fixtureReport().results[0]!,
        evidence: ['.treeseed/scenes/runs/example.scene/run-1'],
        steps: [{
          id: 'scene',
          kind: 'scene',
          status: 'failed',
          summary: 'Scene failed',
          evidence: ['.treeseed/scenes/runs/example.scene/run-1'],
          diagnostics: [],
        }],
      }],
    }));
    const sceneRoot = resolve(root, '.treeseed/scenes/runs/example.scene/run-1');
    mkdirSync(resolve(sceneRoot, 'playwright/screenshots'), { recursive: true });
    mkdirSync(resolve(sceneRoot, 'playwright/screenshots/viewport'), { recursive: true });
    mkdirSync(resolve(sceneRoot, 'logs'), { recursive: true });
    writeFileSync(resolve(sceneRoot, 'playwright/screenshots/open-entry-route.png'), 'image');
    writeFileSync(resolve(sceneRoot, 'playwright/screenshots/fill-form.png'), 'image 2');
    writeFileSync(resolve(sceneRoot, 'playwright/screenshots/viewport/open-entry-route.png'), 'viewport image');
    writeFileSync(resolve(sceneRoot, 'logs/console.jsonl'), 'log');
    writeFileSync(resolve(sceneRoot, 'run.json'), JSON.stringify({
      steps: [
        { id: 'open-entry-route', screenshotPath: resolve(sceneRoot, 'playwright/screenshots/open-entry-route.png') },
        { id: 'fill-form', screenshotPath: resolve(sceneRoot, 'playwright/screenshots/fill-form.png') },
      ],
    }));
    writeFileSync(resolve(runDir, 'report.md'), '# report\n');
    const detail = loadGuaranteeReviewRun(root, 'run-a');
    const screenshots = detail.items[0]?.evidence.filter((entry) => entry.kind === 'screenshot') ?? [];
    expect(screenshots.map((entry) => entry.path)).not.toContain('.treeseed/scenes/runs/example.scene/run-1/playwright/screenshots/viewport/open-entry-route.png');
    expect(screenshots).toHaveLength(2);
    expect(screenshots[0]?.path).toContain('open-entry-route.png');
    expect(screenshots[1]?.path).toContain('fill-form.png');
    expect(detail.items[0]?.primaryScreenshot?.path).toContain('open-entry-route.png');
    expect(detail.items[0]?.primaryLog?.path).toContain('console.jsonl');
  });

  it('marks duplicate screenshots while keeping raw evidence available', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'treeseed-reviewer-'));
    writeRun(root, 'runs', 'run-a', fixtureReport({
      results: [{
        ...fixtureReport().results[0]!,
        evidence: [
          '.treeseed/scenes/runs/example.scene/run-1',
          '.treeseed/scenes/runs/example.scene/run-2',
        ],
        steps: [],
      }],
    }));
    const firstSceneRoot = resolve(root, '.treeseed/scenes/runs/example.scene/run-1');
    const secondSceneRoot = resolve(root, '.treeseed/scenes/runs/example.scene/run-2');
    mkdirSync(resolve(firstSceneRoot, 'playwright/screenshots'), { recursive: true });
    mkdirSync(resolve(secondSceneRoot, 'playwright/screenshots'), { recursive: true });
    writeFileSync(resolve(firstSceneRoot, 'playwright/screenshots/open-entry-route.png'), 'same-image');
    writeFileSync(resolve(secondSceneRoot, 'playwright/screenshots/open-entry-route.png'), 'same-image');

    const detail = loadGuaranteeReviewRun(root, 'run-a');
    const screenshots = detail.items[0]?.evidence.filter((entry) => entry.kind === 'screenshot') ?? [];

    expect(screenshots).toHaveLength(2);
    expect(screenshots[0]?.duplicateCount).toBe(1);
    expect(screenshots[1]?.duplicateOf).toBe(screenshots[0]?.id);
    expect(detail.items[0]?.primaryScreenshot?.id).toBe(screenshots[0]?.id);
    expect(screenshots[0]?.label).toContain('run-1/playwright/screenshots/open-entry-route.png');
  });

  it('marks screenshots repeated across multiple guarantees in one run', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'treeseed-reviewer-'));
    const base = fixtureReport();
    writeRun(root, 'runs', 'run-a', fixtureReport({
      results: [
        {
          ...base.results[0]!,
          id: 'guarantee.reviewer.first.001',
          evidence: ['.treeseed/scenes/runs/example.first/run-1'],
          steps: [],
        },
        {
          ...base.results[0]!,
          id: 'guarantee.reviewer.second.002',
          evidence: ['.treeseed/scenes/runs/example.second/run-1'],
          steps: [],
        },
      ],
    }));
    const firstSceneRoot = resolve(root, '.treeseed/scenes/runs/example.first/run-1');
    const secondSceneRoot = resolve(root, '.treeseed/scenes/runs/example.second/run-1');
    mkdirSync(resolve(firstSceneRoot, 'playwright/screenshots'), { recursive: true });
    mkdirSync(resolve(secondSceneRoot, 'playwright/screenshots'), { recursive: true });
    writeFileSync(resolve(firstSceneRoot, 'playwright/screenshots/open-entry-route.png'), 'same-image');
    writeFileSync(resolve(secondSceneRoot, 'playwright/screenshots/open-entry-route.png'), 'same-image');

    const detail = loadGuaranteeReviewRun(root, 'run-a');
    const firstScreenshot = detail.items[0]?.primaryScreenshot;
    const secondScreenshot = detail.items[1]?.primaryScreenshot;

    expect(firstScreenshot?.runDuplicateGuaranteeCount).toBe(2);
    expect(secondScreenshot?.runDuplicateGuaranteeCount).toBe(2);
    expect(firstScreenshot?.runDuplicateEvidenceCount).toBe(1);
  });

  it('constructs guarantee CLI commands from filter state', () => {
    const args = commandArgsForGuarantees('run', {
      environment: 'local',
      filter: { ownerPackage: '@treeseed/admin', type: 'project', subtype: 'question', gate: 'release', status: 'active', ids: ['a', 'b'], journeyIndexes: [1] },
      includeDependencies: false,
      includePlanned: true,
      record: true,
      sceneArtifacts: 'full',
      evidenceTarget: 'local',
    });
    expect(args).toContain('--no-dependencies');
    expect(args).toContain('--statuses');
    expect(args).toContain('--scene-artifacts');
    expect(args).toContain('full');
    expect(args).toContain('--ids');
    expect(args).toContain('a,b');
  });
});
