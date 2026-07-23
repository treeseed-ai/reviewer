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

