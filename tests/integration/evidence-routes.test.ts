import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
    mkdirSync(resolve(root, 'scripts'), { recursive: true });
    const planShim = resolve(root, 'scripts/plan-composition-guarantees.mjs');
    const runShim = resolve(root, 'scripts/run-composition-guarantees.mjs');
    writeFileSync(planShim, `console.log(JSON.stringify({ ok: true, source: 'plan-route' }));\n`);
    writeFileSync(runShim, `console.log(JSON.stringify({ ok: true, source: 'run-route' }));\n`);
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
    writeFileSync(planShim, 'process.exit(3);\n');
    const failedPlan = await fetch(`${baseUrl}/api/guarantee-runs/plan`, { method: 'POST' });
    expect(failedPlan.status).toBe(500);
    writeFileSync(runShim, 'console.log(JSON.stringify({ ok: true }));\n');
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
