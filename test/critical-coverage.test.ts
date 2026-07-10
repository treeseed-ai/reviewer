import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  commandArgsForGuarantees,
  discoverGuaranteeCatalog,
  discoverGuaranteeRuns,
  loadGuaranteeReviewRun,
  runGuaranteeCommand,
  runStat,
  resolveCommand,
  startGuaranteeRunTask,
} from '../src/server/guarantee-runs.ts';
import { contentTypeFor, serveEvidence, serveEvidenceText } from '../src/server/evidence.ts';
import { handleReviewerRequest } from '../src/server/routes.ts';
import { createWorkplan, draftPath, readDraft, writeDraft } from '../src/server/workplans.ts';
import {
  buildReviewItems,
  evidenceItemsFor,
  inferEvidenceKind,
  recommendedClassification,
  recommendedPriority,
  releaseBlockingPlanEntry,
  rerunCommandFor,
  sortReviewResults,
} from '../src/shared/guarantee-review.ts';
import { REVIEWER_DIRECTIVE_CONSTRAINTS, directiveTypeFor } from '../src/shared/workplan.ts';
import type { ReviewerDirectiveClassification, ReviewerDraftNote, ReviewerTask } from '../src/shared/contracts.ts';
import type { TreeseedGuaranteePlanReport, TreeseedGuaranteeRunReport, TreeseedGuaranteeRunResult } from '@treeseed/sdk/guarantees';

const servers: import('node:http').Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolvePromise) => server.close(() => resolvePromise()))));
});

function tempRoot(prefix = 'treeseed-reviewer-critical-') {
  return mkdtempSync(resolve(tmpdir(), prefix));
}

function baseResult(overrides: Partial<TreeseedGuaranteeRunResult> = {}): TreeseedGuaranteeRunResult {
  return {
    id: 'guarantee.reviewer.sample.001',
    type: 'reviewer',
    subtype: 'workplan',
    journey: 'Review sample',
    ownerPackage: '@treeseed/reviewer',
    status: 'passed',
    selected: true,
    dependency: false,
    sourcePath: 'packages/reviewer/guarantees/reviewer/workplan/create-local-workplan.guarantee.yaml',
    startedAt: '2026-07-08T10:00:00.000Z',
    completedAt: '2026-07-08T10:01:00.000Z',
    steps: [],
    evidence: [],
    diagnostics: [],
    ...overrides,
  };
}

function basePlan(entries: TreeseedGuaranteePlanReport['entries'] = []): TreeseedGuaranteePlanReport {
  return {
    ok: true,
    workspaceRoot: '/tmp/workspace',
    filter: {},
    environment: 'local',
    entries,
    diagnostics: [],
    counts: { total: entries.length, selected: entries.length, withDependencies: entries.length, errors: 0, warnings: 0 },
  };
}

function baseReport(root: string, results: TreeseedGuaranteeRunResult[], plan = basePlan()): TreeseedGuaranteeRunReport {
  return {
    ok: results.every((result) => result.status === 'passed'),
    runId: 'run-a',
    workspaceRoot: root,
    environment: 'local',
    filter: {},
    startedAt: '2026-07-08T10:00:00.000Z',
    completedAt: '2026-07-08T10:01:00.000Z',
    outputRoot: resolve(root, '.treeseed/guarantees/runs/run-a'),
    plan,
    results,
    diagnostics: [],
    counts: {
      planned: results.filter((result) => result.status === 'planned').length,
      passed: results.filter((result) => result.status === 'passed').length,
      failed: results.filter((result) => result.status === 'failed').length,
      skipped: results.filter((result) => result.status === 'skipped').length,
      blocked: results.filter((result) => result.status === 'blocked').length,
      releaseBlockingFailures: 0,
    },
  };
}

function writeRun(root: string, report: TreeseedGuaranteeRunReport, kind: 'runs' | 'release' = 'runs') {
  const runDir = resolve(root, '.treeseed/guarantees', kind, report.runId);
  mkdirSync(runDir, { recursive: true });
  mkdirSync(resolve(root, 'packages/reviewer/guarantees/reviewer/workplan'), { recursive: true });
  writeFileSync(resolve(root, 'packages/reviewer/guarantees/reviewer/workplan/create-local-workplan.guarantee.yaml'), 'schemaVersion: treeseed.guarantee/v1\n');
  writeFileSync(resolve(runDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(resolve(runDir, 'plan.json'), `${JSON.stringify(report.plan, null, 2)}\n`);
  writeFileSync(resolve(runDir, 'report.md'), '# Report\n');
  return runDir;
}

function mockResponse() {
  const chunks: Buffer[] = [];
  const response = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    writeHead(status: number, headers: Record<string, string>) {
      this.statusCode = status;
      this.headers = headers;
      return this;
    },
    end(chunk?: string | Buffer) {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    },
    write(chunk: string | Buffer) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      return true;
    },
    on() {
      return this;
    },
  } as unknown as ServerResponse & { statusCode: number; headers: Record<string, string> };
  return { response, body: () => Buffer.concat(chunks).toString('utf8') };
}

describe('reviewer critical coverage helpers', () => {
  it('classifies all evidence kinds and directive types', () => {
    expect(inferEvidenceKind('screen.jpeg')).toBe('screenshot');
    expect(inferEvidenceKind('screen.webp')).toBe('screenshot');
    expect(inferEvidenceKind('events.jsonl')).toBe('log');
    expect(inferEvidenceKind('manifest.json')).toBe('manifest');
    expect(inferEvidenceKind('report.markdown')).toBe('markdown');
    expect(inferEvidenceKind('movie.webm')).toBe('video');
    expect(inferEvidenceKind('trace.zip')).toBe('trace');
    expect(inferEvidenceKind('table.csv')).toBe('csv');
    expect(inferEvidenceKind('app-log')).toBe('log');
    expect(inferEvidenceKind('artifact.bin')).toBe('unknown');
    const mappings: Array<[ReviewerDirectiveClassification, string]> = [
      ['ux-improvement', 'improvement'],
      ['test-defect', 'test-repair'],
      ['weak-guarantee', 'guarantee-repair'],
      ['fixture-environment-defect', 'fixture-repair'],
      ['investigate', 'investigation'],
      ['product-defect', 'fix'],
    ];
    for (const [classification, expected] of mappings) expect(directiveTypeFor(classification)).toBe(expected);
    expect(REVIEWER_DIRECTIVE_CONSTRAINTS.length).toBeGreaterThan(0);
  });

  it('computes priority, classification, sorting, and rerun defaults', () => {
    const releaseEntry = {
      id: 'g1',
      type: 'project',
      subtype: 'question',
      journey: 'Question',
      ownerPackage: '@treeseed/admin',
      status: 'active',
      gates: ['release'],
      sourcePath: 'g.yaml',
      selected: true,
      dependency: false,
      apiVerifierRefs: [],
      contentVerifierRefs: [],
      auditVerifierRefs: [],
      evidenceRequired: [],
    };
    expect(releaseBlockingPlanEntry(releaseEntry)).toBe(true);
    expect(releaseBlockingPlanEntry()).toBe(false);
    expect(recommendedPriority(baseResult({ status: 'failed' }), releaseEntry)).toBe('release-blocking');
    expect(recommendedPriority(baseResult({ status: 'blocked', selected: false }))).toBe('high');
    expect(recommendedPriority(baseResult({ status: 'skipped' }))).toBe('medium');
    expect(recommendedPriority(baseResult({ status: 'passed' }))).toBe('low');
    expect(recommendedClassification(baseResult({ status: 'passed' }))).toBe('ux-improvement');
    expect(recommendedClassification(baseResult({ status: 'skipped' }))).toBe('investigate');
    expect(recommendedClassification(baseResult({ status: 'failed', diagnostics: [{ severity: 'error', code: 'seed.failed', message: 'fixture missing' }] }))).toBe('fixture-environment-defect');
    expect(recommendedClassification(baseResult({ status: 'failed', steps: [{ id: 'scene', kind: 'scene', status: 'failed', evidence: [], diagnostics: [] }] }))).toBe('ui-defect');
    expect(recommendedClassification(baseResult({ status: 'failed' }))).toBe('product-defect');
    expect(rerunCommandFor(baseResult(), 'staging')).toContain('--environment staging');

    const report = baseReport('/tmp/workspace', [
      baseResult({ id: 'passed', status: 'passed', journeyIndex: 2 }),
      baseResult({ id: 'failed', status: 'failed', journeyIndex: 1 }),
      baseResult({ id: 'failed-dependency', status: 'failed', selected: false, journeyIndex: 5 }),
      baseResult({ id: 'skipped', status: 'skipped', journeyIndex: 3 }),
      baseResult({ id: 'blocked', status: 'blocked', journeyIndex: 4 }),
      baseResult({ id: 'blocked-selected', status: 'blocked', journeyIndex: 6 }),
    ], basePlan([{ ...releaseEntry, id: 'blocked' }]));
    expect(sortReviewResults(report, report.plan).map((result) => result.id)).toEqual(['blocked', 'blocked-selected', 'failed', 'failed-dependency', 'skipped', 'passed']);
  });

  it('resolves evidence from workspace, run roots, directories, missing files, and labels', () => {
    const root = tempRoot();
    const runDir = resolve(root, '.treeseed/guarantees/runs/run-a');
    mkdirSync(resolve(runDir, 'evidence'), { recursive: true });
    mkdirSync(resolve(root, '.treeseed/scenes/runs/scene-a/run-1/playwright/screenshots'), { recursive: true });
    mkdirSync(resolve(root, '.treeseed/scenes/runs/scene-a/run-1/playwright/screenshots/viewport'), { recursive: true });
    mkdirSync(resolve(root, '.treeseed/scenes/runs/scene-a/run-1/logs'), { recursive: true });
    mkdirSync(resolve(root, '.treeseed/scenes/runs/scene-a/run-2/playwright/screenshots'), { recursive: true });
    writeFileSync(resolve(runDir, 'evidence/result.json'), '{}');
    writeFileSync(resolve(root, '.treeseed/scenes/runs/scene-a/run-1/playwright/screenshots/step-a.png'), 'image-a');
    writeFileSync(resolve(root, '.treeseed/scenes/runs/scene-a/run-1/playwright/screenshots/step-b.png'), 'image-a');
    writeFileSync(resolve(root, '.treeseed/scenes/runs/scene-a/run-1/playwright/screenshots/viewport/step-a.png'), 'viewport');
    writeFileSync(resolve(root, '.treeseed/scenes/runs/scene-a/run-1/logs/console.jsonl'), 'log');
    writeFileSync(resolve(root, '.treeseed/scenes/runs/scene-a/run-1/report.md'), 'markdown');
    writeFileSync(resolve(root, '.treeseed/scenes/runs/scene-a/run-1/video.mp4'), 'video');
    writeFileSync(resolve(root, '.treeseed/scenes/runs/scene-a/run-1/trace.zip'), 'trace');
    writeFileSync(resolve(root, '.treeseed/scenes/runs/scene-a/run-1/a.json'), '{}');
    writeFileSync(resolve(root, '.treeseed/scenes/runs/scene-a/run-1/run.json'), JSON.stringify({ steps: [{ id: 'no-shot' }] }));
    writeFileSync(resolve(root, '.treeseed/scenes/runs/scene-a/run-2/run.json'), JSON.stringify({}));
    writeFileSync(resolve(root, '.treeseed/scenes/runs/scene-a/run-2/playwright/screenshots/only.png'), 'image');
    writeFileSync(resolve(root, '.treeseed/scenes/runs/scene-a/run-1/unknown.bin'), 'unknown');
    symlinkSync(resolve(root, '.treeseed/scenes/runs/scene-a/run-1/a.json'), resolve(root, '.treeseed/scenes/runs/scene-a/run-1/link.json'));
    mkdirSync(resolve(root, '.treeseed/scenes/runs/scene-a/run-1/nested'), { recursive: true });
    mkdirSync(resolve(root, '.treeseed/scenes/runs/scene-a/run-1/deep/1/2/3/4/5/6'), { recursive: true });
    writeFileSync(resolve(root, '.treeseed/scenes/runs/scene-a/run-1/deep/1/2/3/4/5/6/too-deep.png'), 'deep');
    const absoluteLog = resolve(runDir, 'evidence/absolute.log');
    writeFileSync(absoluteLog, 'absolute');
    const result = baseResult({
      evidence: ['evidence/result.json', '.treeseed/scenes/runs/scene-a/run-1', '.treeseed/scenes/runs/scene-a/run-2', absoluteLog, 'missing.txt', ''],
      steps: [
        { id: 'step-a', kind: 'scene', status: 'passed', evidence: ['.treeseed/scenes/runs/scene-a/run-1'], diagnostics: [] },
        { id: 'step-b', kind: 'api', status: 'passed', diagnostics: [] } as never,
      ],
    });
    const items = evidenceItemsFor({ workspaceRoot: root, runOutputRoot: runDir, result });
    expect(items.some((item) => item.kind === 'json' && item.exists)).toBe(true);
    expect(items.filter((item) => item.kind === 'screenshot')).toHaveLength(3);
    expect(items.some((item) => item.path.includes('/viewport/'))).toBe(false);
    expect(items.some((item) => !item.exists && item.path === 'missing.txt')).toBe(true);
    expect(items.find((item) => item.duplicateOf)?.contentHash).toBeDefined();
    expect(items.some((item) => item.label.includes('step-a'))).toBe(true);
    expect(items.some((item) => item.kind === 'markdown')).toBe(true);
    expect(items.some((item) => item.kind === 'video')).toBe(true);
    expect(items.some((item) => item.kind === 'trace')).toBe(true);
    expect(items.some((item) => item.kind === 'json')).toBe(true);
    expect(items.some((item) => item.path === absoluteLog)).toBe(true);
    expect(items.some((item) => item.path.includes('too-deep'))).toBe(false);
  });

  it('builds review items with logs, JSON fallback, dependency flags, and duplicate groups', () => {
    const root = tempRoot();
    const runDir = resolve(root, '.treeseed/guarantees/runs/run-a');
    mkdirSync(resolve(runDir, 'logs'), { recursive: true });
    mkdirSync(resolve(runDir, 'evidence'), { recursive: true });
    writeFileSync(resolve(runDir, 'logs/app.log'), 'error');
    writeFileSync(resolve(runDir, 'evidence/report.json'), '{}');
    const first = baseResult({ id: 'a', evidence: ['logs/app.log'], steps: [{ id: 'verify', kind: 'api', status: 'passed', summary: 'ok', evidence: [], diagnostics: [] }] });
    const second = baseResult({ id: 'b', evidence: ['evidence/report.json'], selected: false, dependency: true, steps: [] });
    const plan = basePlan([{ id: 'b', type: 'reviewer', subtype: 'workplan', journey: 'B', ownerPackage: '@treeseed/reviewer', status: 'active', gates: ['security'], sourcePath: 'b.yaml', selected: false, dependency: true, apiVerifierRefs: [], contentVerifierRefs: [], auditVerifierRefs: [], evidenceRequired: [] }]);
    const items = buildReviewItems({ workspaceRoot: root, run: { runId: 'run-a', kind: 'local', outputRoot: runDir, reportPath: resolve(runDir, 'report.json'), environment: 'local', startedAt: '', ok: true, filter: {}, counts: { planned: 0, passed: 2, failed: 0, skipped: 0, blocked: 0, releaseBlockingFailures: 0 } }, report: baseReport(root, [first, second], plan), plan });
    expect(items[0]?.primaryLog?.kind).toBe('log');
    expect(items[1]?.primaryLog?.kind).toBe('json');
    expect(items[1]?.dependency).toBe(true);
    expect(items[1]?.releaseBlocking).toBe(true);
  });
});

describe('reviewer server module coverage', () => {
  it('discovers malformed and release runs safely and loads run paths', () => {
    const root = tempRoot();
    const run = baseReport(root, [baseResult()]);
    writeRun(root, run);
    const releaseDir = writeRun(root, { ...run, runId: 'release-a', startedAt: '2026-07-08T12:00:00.000Z', completedAt: undefined }, 'release');
    writeFileSync(resolve(releaseDir, 'generated.csv'), 'id,status\n');
    writeRun(root, { ...run, runId: 'no-completed-a', startedAt: '2026-07-08T07:00:00.000Z', completedAt: undefined });
    writeRun(root, { ...run, runId: 'no-completed-b', startedAt: '2026-07-08T08:00:00.000Z', completedAt: undefined });
    mkdirSync(resolve(root, '.treeseed/guarantees/runs/bad'), { recursive: true });
    writeFileSync(resolve(root, '.treeseed/guarantees/runs/not-directory.txt'), 'ignored');
    writeFileSync(resolve(root, '.treeseed/guarantees/runs/bad/report.json'), '{bad');
    writeRun(root, { ...run, runId: 'failed-a', startedAt: '2026-07-08T09:00:00.000Z', completedAt: '2026-07-08T09:00:01.000Z', counts: { planned: 0, passed: 0, failed: 1, skipped: 0, blocked: 0, releaseBlockingFailures: 1 } });
    const fallbackDir = resolve(root, '.treeseed/guarantees/runs/fallback-id');
    mkdirSync(fallbackDir, { recursive: true });
    const fallbackReport = { ...run };
    delete (fallbackReport as Partial<TreeseedGuaranteeRunReport>).runId;
    writeFileSync(resolve(fallbackDir, 'report.json'), `${JSON.stringify(fallbackReport, null, 2)}\n`);
    const runs = discoverGuaranteeRuns(root);
    expect(runs.map((entry) => entry.runId)).toContain('release-a');
    expect(runs.map((entry) => entry.runId)).not.toContain('bad');
    expect(runs[0]?.runId).toBe('failed-a');
    expect(loadGuaranteeReviewRun(root, '.treeseed/guarantees/runs/run-a').run.runId).toBe('run-a');
    expect(loadGuaranteeReviewRun(root, 'release-a').run.kind).toBe('release');
    expect(discoverGuaranteeRuns(root).some((entry) => entry.runId === 'fallback-id')).toBe(true);
    expect(discoverGuaranteeRuns(root).some((entry) => entry.generatedCsvPath?.endsWith('generated.csv'))).toBe(true);
    expect(() => loadGuaranteeReviewRun(root, 'missing')).toThrow(/not found/u);
    expect(runStat(resolve(root, 'missing'))).toBeNull();
    expect(runStat(resolve(root, '.treeseed/guarantees/runs/run-a'))?.isDirectory()).toBe(true);
  });

  it('discovers guarantee catalog entries from the workspace', () => {
    const root = tempRoot();
    const first = resolve(root, 'guarantees/reviewer/workplan/a.guarantee.yaml');
    const second = resolve(root, 'guarantees/reviewer/workplan/b.guarantee.yaml');
    mkdirSync(resolve(root, 'guarantees/reviewer/workplan'), { recursive: true });
    const manifest = (id: string, status: string, journey: string, ownerPackage = '@treeseed/reviewer') => `schemaVersion: treeseed.guarantee/v1
id: ${id}
journeyIndex: 1
type: reviewer
subtype: workplan
journey: ${journey}
ownerPackage: "${ownerPackage}"
surface: cli
summary: ${journey}
status: ${status}
actors:
  allowed: [local-operator]
  forbidden: [remote-user]
devices:
  required: [desktop_chromium]
gates: [core]
preconditions:
  fixtures: []
scene:
  required: false
api:
  required: false
content:
  required: false
audit:
  required: false
evidence:
  required: []
`;
    writeFileSync(first, manifest('guarantee.reviewer.workplan.active.001', 'active', 'Active Review'));
    writeFileSync(second, manifest('guarantee.reviewer.workplan.planned.002', 'planned', 'Planned Review'));
    writeFileSync(resolve(root, 'guarantees/reviewer/workplan/c.guarantee.yaml'), manifest('guarantee.reviewer.workplan.active.003', 'active', 'A Active Review', '@treeseed/admin'));
    writeFileSync(resolve(root, 'guarantees/reviewer/workplan/d.guarantee.yaml'), manifest('guarantee.reviewer.workplan.active.004', 'active', 'Z Active Review'));
    const catalog = discoverGuaranteeCatalog(root);
    expect(catalog.at(-1)?.status).toBe('planned');
    expect(catalog.every((entry) => entry.label.includes(entry.ownerPackage))).toBe(true);
  });

  it('constructs minimal plan commands and executes workspace trsd shims', async () => {
    const root = tempRoot();
    mkdirSync(resolve(root, 'node_modules/.bin'), { recursive: true });
    const shim = resolve(root, 'node_modules/.bin/trsd');
    writeFileSync(shim, '#!/usr/bin/env node\nconsole.error("shim stderr"); console.log("prefix"); console.log(JSON.stringify({ok:true, command:"shim"}));\n');
    chmodSync(shim, 0o755);
    expect(commandArgsForGuarantees('plan', { environment: 'local', filter: {}, includeDependencies: true, includePlanned: false })).toEqual(['trsd', 'guarantees', 'plan', '--environment', 'local', '--json']);
    expect(commandArgsForGuarantees('run', { environment: 'local', includeDependencies: true, includePlanned: false, record: false, device: 'desktop_chromium' } as never)).toContain('desktop_chromium');
    expect(resolveCommand(root, 'node')).toBe('node');
    const result = await runGuaranteeCommand(root, { environment: 'local', filter: {}, includeDependencies: true, includePlanned: false });
    expect(result.ok).toBe(true);
    expect(result.stderr).toContain('shim stderr');
    expect(result.report).toMatchObject({ ok: true, command: 'shim' });

    writeFileSync(shim, '#!/usr/bin/env node\nconsole.log("not json");\n');
    chmodSync(shim, 0o755);
    const textResult = await runGuaranteeCommand(root, { environment: 'local', filter: {}, includeDependencies: true, includePlanned: false });
    expect(textResult.report).toBeUndefined();

    writeFileSync(shim, '#!/usr/bin/env node\nprocess.exit(2);\n');
    chmodSync(shim, 0o755);
    const failedResult = await runGuaranteeCommand(root, { environment: 'local', filter: {}, includeDependencies: true, includePlanned: false }, 'plan');
    expect(failedResult.ok).toBe(false);
  });

  it('streams task output, detects new runs, and records failed spawn errors', async () => {
    const root = tempRoot();
    mkdirSync(resolve(root, 'node_modules/.bin'), { recursive: true });
    const shim = resolve(root, 'node_modules/.bin/trsd');
    writeFileSync(shim, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
console.log('[guarantees][run] starting');
const root = process.cwd();
const runDir = path.join(root, '.treeseed/guarantees/runs/run-created');
fs.mkdirSync(runDir, { recursive: true });
fs.writeFileSync(path.join(runDir, 'report.json'), JSON.stringify({ ok: true, runId: 'run-created', workspaceRoot: root, environment: 'local', filter: {}, startedAt: '2026-07-08T10:00:00.000Z', outputRoot: runDir, plan: { entries: [] }, results: [], diagnostics: [], counts: { planned: 0, passed: 0, failed: 0, skipped: 0, blocked: 0, releaseBlockingFailures: 0 } }));
console.error('[guarantees][stderr] ok');
`);
    chmodSync(shim, 0o755);
    const tasks = new Map<string, ReviewerTask>();
    const task = startGuaranteeRunTask({ workspaceRoot: root, request: { environment: 'local', filter: {}, includeDependencies: true, includePlanned: false, record: false, sceneArtifacts: 'screenshots', evidenceTarget: 'local' }, tasks });
    await new Promise<void>((resolvePromise) => {
      const timer = setInterval(() => {
        if (task.status !== 'running') {
          clearInterval(timer);
          resolvePromise();
        }
      }, 10);
    });
    expect(task.status).toBe('completed');
    expect(task.output.join('')).toContain('spawned process pid');
    expect(task.run?.runId).toBe('run-created');

    const missingRoot = tempRoot();
    const oldPath = process.env.PATH;
    process.env.PATH = '';
    const failedTask = startGuaranteeRunTask({ workspaceRoot: missingRoot, request: { environment: 'local', filter: {}, includeDependencies: true, includePlanned: false, record: false, sceneArtifacts: 'screenshots', evidenceTarget: 'local' }, tasks: new Map() });
    await new Promise<void>((resolvePromise) => {
      const timer = setInterval(() => {
        if (failedTask.status !== 'running') {
          clearInterval(timer);
          resolvePromise();
        }
      }, 10);
    });
    process.env.PATH = oldPath;
    expect(failedTask.status).toBe('failed');
    expect(failedTask.result?.ok).toBe(false);
  });

  it('records heartbeat output for long-running guarantee tasks', async () => {
    const root = tempRoot();
    writeRun(root, { ...baseReport(root, [baseResult()]), runId: 'run-a', startedAt: '2026-07-08T10:00:00.000Z' });
    writeRun(root, { ...baseReport(root, [baseResult()]), runId: 'run-b', startedAt: '2026-07-08T11:00:00.000Z' });
    mkdirSync(resolve(root, 'node_modules/.bin'), { recursive: true });
    const shim = resolve(root, 'node_modules/.bin/trsd');
    writeFileSync(shim, `#!/usr/bin/env node
setTimeout(() => {
  console.log('done');
}, 5200);
`);
    chmodSync(shim, 0o755);
    const task = startGuaranteeRunTask({ workspaceRoot: root, request: { environment: 'local', filter: {}, includeDependencies: true, includePlanned: false, record: false, sceneArtifacts: 'screenshots', evidenceTarget: 'local' }, tasks: new Map() });
    await new Promise<void>((resolvePromise) => {
      const timer = setInterval(() => {
        if (task.status !== 'running') {
          clearInterval(timer);
          resolvePromise();
        }
      }, 25);
    });
    expect(task.output.join('')).toContain('still running');
    expect(task.output.join('')).toContain('latest guarantee run detected');
  }, 10_000);

  it('records unknown exit code when a guarantee task exits by signal', async () => {
    const root = tempRoot();
    mkdirSync(resolve(root, 'node_modules/.bin'), { recursive: true });
    const shim = resolve(root, 'node_modules/.bin/trsd');
    writeFileSync(shim, '#!/usr/bin/env node\nprocess.kill(process.pid, "SIGTERM");\n');
    chmodSync(shim, 0o755);
    const task = startGuaranteeRunTask({ workspaceRoot: root, request: { environment: 'local', filter: {}, includeDependencies: true, includePlanned: false, record: false, sceneArtifacts: 'screenshots', evidenceTarget: 'local' }, tasks: new Map() });
    await new Promise<void>((resolvePromise) => {
      const timer = setInterval(() => {
        if (task.status !== 'running') {
          clearInterval(timer);
          resolvePromise();
        }
      }, 10);
    });
    expect(task.output.join('')).toContain('code unknown');
  });
});

describe('evidence and route coverage', () => {
  it('serves evidence types, text ranges, and errors', () => {
    const root = tempRoot();
    mkdirSync(resolve(root, 'evidence'), { recursive: true });
    writeFileSync(resolve(root, 'evidence/file.unknown'), 'data');
    writeFileSync(resolve(root, 'evidence/file.txt'), 'a\nb\nc\n');
    expect(contentTypeFor('photo.avif')).toBe('image/avif');
    expect(contentTypeFor('photo.svg')).toBe('image/svg+xml');
    expect(contentTypeFor('archive.zip')).toBe('application/zip');
    expect(contentTypeFor('file.unknown')).toBe('application/octet-stream');
    expect(() => serveEvidence(root, new URL('http://local/api/evidence'), {} as never, mockResponse().response)).toThrow(/Missing evidence path/u);
    expect(() => serveEvidenceText(root, new URL('http://local/api/evidence/text'), mockResponse().response)).toThrow(/Missing evidence path/u);
    const missing = mockResponse();
    serveEvidence(root, new URL('http://local/api/evidence?path=evidence/missing.txt'), {} as never, missing.response);
    expect(missing.response.statusCode).toBe(404);
    const text = mockResponse();
    serveEvidenceText(root, new URL('http://local/api/evidence/text?path=evidence/file.txt&startLine=-10&lineCount=9999'), text.response);
    expect(JSON.parse(text.body())).toMatchObject({ startLine: 0, lineCount: 2000 });
    const defaults = mockResponse();
    serveEvidenceText(root, new URL('http://local/api/evidence/text?path=evidence/file.txt'), defaults.response);
    expect(JSON.parse(defaults.body())).toMatchObject({ startLine: 0, lineCount: 400 });
    const invalidRange = mockResponse();
    serveEvidenceText(root, new URL('http://local/api/evidence/text?path=evidence/file.txt&startLine=not-a-number&lineCount=0'), invalidRange.response);
    expect(JSON.parse(invalidRange.body())).toMatchObject({ startLine: 0, lineCount: 400 });
    const missingText = mockResponse();
    serveEvidenceText(root, new URL('http://local/api/evidence/text?path=evidence/nope.txt'), missingText.response);
    expect(missingText.response.statusCode).toBe(404);
  });

  it('covers route success, error, static fallback, and unbuilt UI branches', async () => {
    const root = tempRoot();
    const uiRoot = resolve(root, 'ui');
    mkdirSync(uiRoot, { recursive: true });
    writeFileSync(resolve(uiRoot, 'index.html'), '<main>Index</main>');
    writeFileSync(resolve(uiRoot, 'app.js'), 'console.log("ok")');
    writeFileSync(resolve(uiRoot, 'style.css'), 'body{}');
    writeFileSync(resolve(uiRoot, 'icon.svg'), '<svg/>');
    writeFileSync(resolve(uiRoot, 'data.json'), '{}');
    writeFileSync(resolve(uiRoot, 'image.png'), 'png');
    writeFileSync(resolve(uiRoot, 'file.bin'), 'bin');
    mkdirSync(resolve(root, 'node_modules/.bin'), { recursive: true });
    const shim = resolve(root, 'node_modules/.bin/trsd');
    writeFileSync(shim, `#!/usr/bin/env node
if (process.argv.includes('plan')) {
  console.log(JSON.stringify({ ok: true, source: 'plan-route' }));
  process.exit(0);
}
console.log(JSON.stringify({ ok: true, source: 'run-route' }));
process.exit(0);
`);
    chmodSync(shim, 0o755);
    writeRun(root, baseReport(root, [baseResult()]));
    const task: ReviewerTask = { id: 'running', status: 'running', command: [], startedAt: '', stdout: [], stderr: [], output: [], lastOutputAt: '' };
    const context = { workspaceRoot: root, uiRoot, version: 'test', tasks: new Map([[task.id, task]]) };
    const server = createServer((request, response) => {
      void handleReviewerRequest(context, request, response);
    });
    servers.push(server);
    const baseUrl = await new Promise<string>((resolvePromise) => server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('bad address');
      resolvePromise(`http://127.0.0.1:${address.port}`);
    }));
    expect((await fetch(`${baseUrl}/api/guarantee-runs/missing`)).status).toBe(500);
    expect((await fetch(`${baseUrl}/api/guarantee-catalog`)).status).toBe(200);
    const plan = await fetch(`${baseUrl}/api/guarantee-runs/plan`, { method: 'POST', body: JSON.stringify({ environment: 'local', filter: {}, includeDependencies: true, includePlanned: false }) });
    expect(plan.status).toBe(200);
    writeFileSync(shim, '#!/usr/bin/env node\nprocess.exit(3);\n');
    chmodSync(shim, 0o755);
    const failedPlan = await fetch(`${baseUrl}/api/guarantee-runs/plan`, { method: 'POST' });
    expect(failedPlan.status).toBe(500);
    writeFileSync(shim, '#!/usr/bin/env node\nconsole.log(JSON.stringify({ ok: true }));\n');
    chmodSync(shim, 0o755);
    const run = await fetch(`${baseUrl}/api/guarantee-runs/run`, { method: 'POST', body: JSON.stringify({ environment: 'local', filter: {}, includeDependencies: true, includePlanned: false, record: false, sceneArtifacts: 'screenshots', evidenceTarget: 'local' }) });
    expect(run.status).toBe(202);
    expect((await fetch(`${baseUrl}/app.js`)).headers.get('content-type')).toContain('text/javascript');
    expect(await (await fetch(`${baseUrl}/missing.js`)).text()).toContain('Index');
    expect((await fetch(`${baseUrl}/style.css`)).headers.get('content-type')).toContain('text/css');
    expect((await fetch(`${baseUrl}/icon.svg`)).headers.get('content-type')).toContain('image/svg+xml');
    expect((await fetch(`${baseUrl}/image.png`)).headers.get('content-type')).toContain('image/png');
    expect((await fetch(`${baseUrl}/data.json`)).headers.get('content-type')).toContain('application/json');
    expect((await fetch(`${baseUrl}/file.bin`)).headers.get('content-type')).toContain('application/octet-stream');
    expect(await (await fetch(`${baseUrl}/nested/route`)).text()).toContain('Index');
    task.status = 'completed';
    const eventResponse = await fetch(`${baseUrl}/api/tasks/running/events`);
    const eventText = await eventResponse.text();
    expect(eventText).toContain('running');
    expect((await fetch(`${baseUrl}/api/tasks/nope`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/api/tasks/nope/events`)).status).toBe(404);
    const runningController = new AbortController();
    task.status = 'running';
    const runningResponse = await fetch(`${baseUrl}/api/tasks/running/events`, { signal: runningController.signal });
    expect(runningResponse.status).toBe(200);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 650));
    runningController.abort();
    await expect(runningResponse.text()).rejects.toThrow();
    task.status = 'completed';

    const unbuiltRoot = tempRoot();
    const unbuiltServer = createServer((request, response) => {
      void handleReviewerRequest({ workspaceRoot: unbuiltRoot, uiRoot: resolve(unbuiltRoot, 'missing-ui'), version: 'test', tasks: new Map() }, request, response);
    });
    servers.push(unbuiltServer);
    const unbuiltUrl = await new Promise<string>((resolvePromise) => unbuiltServer.listen(0, '127.0.0.1', () => {
      const address = unbuiltServer.address();
      if (!address || typeof address === 'string') throw new Error('bad address');
      resolvePromise(`http://127.0.0.1:${address.port}`);
    }));
    expect((await fetch(unbuiltUrl)).status).toBe(503);
  });
});

describe('workplan edge coverage', () => {
  it('handles missing draft evidence, missing context files, and selection errors', () => {
    const root = tempRoot();
    const runDir = resolve(root, '.treeseed/guarantees/runs/run-a');
    mkdirSync(resolve(runDir, 'evidence'), { recursive: true });
    mkdirSync(resolve(root, 'packages/reviewer/guarantees/reviewer/workplan/scenes'), { recursive: true });
    writeFileSync(resolve(root, 'packages/reviewer/guarantees/reviewer/workplan/create-local-workplan.guarantee.yaml'), 'schemaVersion: treeseed.guarantee/v1\n');
    writeFileSync(resolve(root, 'packages/reviewer/guarantees/reviewer/workplan/scenes/create.scene.yaml'), 'schemaVersion: treeseed.scene/v1\n');
    const result = baseResult({
      status: 'blocked',
      evidence: ['evidence/missing.png'],
      steps: [{ id: 'blocked-step', kind: 'scene', ref: 'scene.ref', status: 'blocked', evidence: ['evidence/missing.png'], diagnostics: [] }],
      diagnostics: [{ severity: 'error', code: 'guarantee.dependency_failed', message: 'blocked' }],
    });
    const plan = basePlan([{ id: result.id, type: result.type, subtype: result.subtype, journey: result.journey, ownerPackage: result.ownerPackage, status: 'active', gates: ['core'], sourcePath: result.sourcePath, selected: true, dependency: false, sceneManifest: 'scenes/create.scene.yaml', apiVerifierRefs: [], contentVerifierRefs: [], auditVerifierRefs: [], evidenceRequired: [] }]);
    writeRun(root, baseReport(root, [result], plan));
    expect(() => createWorkplan(root, { runId: 'run-a', title: 'Empty', includeGuaranteeIds: [], copyRawEvidence: true })).toThrow(/No guarantee/u);
    const draft: ReviewerDraftNote = { schemaVersion: 'treeseed.reviewer.draft-note/v1', runId: 'run-a', guaranteeId: result.id, updatedAt: '', classification: 'weak-guarantee', priority: 'medium', ownerPackage: '@treeseed/reviewer', note: '', selectedEvidenceIds: [], includeInWorkplan: true };
    writeDraft(root, draft);
    expect(draftPath(root, 'run/a', 'guarantee:a')).toContain('guarantee-a.json');
    expect(readDraft(root, 'missing', 'missing')).toBeNull();
    const response = createWorkplan(root, { runId: 'run-a', title: 'Missing evidence', includeGuaranteeIds: [result.id], copyRawEvidence: true });
    const manifest = JSON.parse(readFileSync(resolve(response.workplanRoot, 'evidence/manifest.json'), 'utf8')) as { evidence: Array<{ exists: boolean }> };
    expect(manifest.evidence.some((entry) => !entry.exists)).toBe(true);
    expect(readFileSync(response.workplanMarkdownPath, 'utf8')).toContain('(No note supplied.)');
    expect(existsSync(resolve(response.workplanRoot, 'commands/verify.sh'))).toBe(true);

    const noPlanRoot = tempRoot();
    const noPlanReport = baseReport(noPlanRoot, [baseResult({ evidence: [] })], { ...basePlan(), entries: [] });
    writeRun(noPlanRoot, noPlanReport);
    const noPlanResponse = createWorkplan(noPlanRoot, { runId: 'run-a', title: 'No plan scene', includeGuaranteeIds: ['guarantee.reviewer.sample.001'], copyRawEvidence: true });
    expect(readFileSync(noPlanResponse.workplanMarkdownPath, 'utf8')).toContain('Owner packages');

    const missingContextRoot = tempRoot();
    const missingContextResult = baseResult({ sourcePath: 'packages/reviewer/guarantees/reviewer/workplan/missing.guarantee.yaml', evidence: [] });
    const missingContextPlan = basePlan([{ id: missingContextResult.id, type: missingContextResult.type, subtype: missingContextResult.subtype, journey: missingContextResult.journey, ownerPackage: missingContextResult.ownerPackage, status: 'active', gates: ['core'], sourcePath: missingContextResult.sourcePath, selected: true, dependency: false, sceneManifest: 'scenes/missing.scene.yaml', apiVerifierRefs: [], contentVerifierRefs: [], auditVerifierRefs: [], evidenceRequired: [] }]);
    const missingContextRun = writeRun(missingContextRoot, baseReport(missingContextRoot, [missingContextResult], missingContextPlan));
    rmSync(resolve(missingContextRun, 'plan.json'));
    rmSync(resolve(missingContextRun, 'report.md'));
    const responseWithoutContext = createWorkplan(missingContextRoot, { runId: 'run-a', title: 'Missing context files', includeGuaranteeIds: [missingContextResult.id], copyRawEvidence: true });
    expect(existsSync(responseWithoutContext.agentBriefPath)).toBe(true);

    const missingSceneRoot = tempRoot();
    const missingSceneResult = baseResult({ sourcePath: 'packages/reviewer/guarantees/reviewer/workplan/create-local-workplan.guarantee.yaml', evidence: [] });
    const missingScenePlan = basePlan([{ id: missingSceneResult.id, type: missingSceneResult.type, subtype: missingSceneResult.subtype, journey: missingSceneResult.journey, ownerPackage: missingSceneResult.ownerPackage, status: 'active', gates: ['core'], sourcePath: missingSceneResult.sourcePath, selected: true, dependency: false, sceneManifest: 'scenes/missing.scene.yaml', apiVerifierRefs: [], contentVerifierRefs: [], auditVerifierRefs: [], evidenceRequired: [] }]);
    writeRun(missingSceneRoot, baseReport(missingSceneRoot, [missingSceneResult], missingScenePlan));
    const missingSceneResponse = createWorkplan(missingSceneRoot, { runId: 'run-a', title: 'Missing scene manifest', includeGuaranteeIds: [missingSceneResult.id], copyRawEvidence: true });
    expect(existsSync(missingSceneResponse.workplanYamlPath)).toBe(true);
  });
});
