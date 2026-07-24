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
} from '../../src/server/guarantee-runs.ts';
import { contentTypeFor, serveEvidence, serveEvidenceText } from '../../src/server/evidence.ts';
import { handleReviewerRequest } from '../../src/server/routes.ts';
import { createWorkplan, draftPath, readDraft, writeDraft } from '../../src/server/workplans.ts';
import {
  buildReviewItems,
  evidenceItemsFor,
  inferEvidenceKind,
  recommendedClassification,
  recommendedPriority,
  releaseBlockingPlanEntry,
  rerunCommandFor,
  sortReviewResults,
} from '../../src/shared/guarantee-review.ts';
import { REVIEWER_DIRECTIVE_CONSTRAINTS, directiveTypeFor } from '../../src/shared/workplan.ts';
import type { ReviewerDirectiveClassification, ReviewerDraftNote, ReviewerTask } from '../../src/shared/contracts.ts';
import type { GuaranteePlanReport, GuaranteeRunReport, GuaranteeRunResult } from '@treeseed/sdk/guarantees';

const servers: import('node:http').Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolvePromise) => server.close(() => resolvePromise()))));
});

function tempRoot(prefix = 'treeseed-reviewer-critical-') {
  return mkdtempSync(resolve(tmpdir(), prefix));
}

function baseResult(overrides: Partial<GuaranteeRunResult> = {}): GuaranteeRunResult {
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

function basePlan(entries: GuaranteePlanReport['entries'] = []): GuaranteePlanReport {
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

function baseReport(root: string, results: GuaranteeRunResult[], plan = basePlan()): GuaranteeRunReport {
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

function writeRun(root: string, report: GuaranteeRunReport, kind: 'runs' | 'release' = 'runs') {
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

