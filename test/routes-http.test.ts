import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { handleReviewerRequest } from '../src/server/routes.ts';
import type { ReviewerTask } from '../src/shared/contracts.ts';
import type { ReviewerServerContext } from '../src/server/workspace.ts';

const servers: Server[] = [];

function listen(server: Server): Promise<string> {
  servers.push(server);
  return new Promise((resolvePromise) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Unexpected server address.');
      resolvePromise(`http://127.0.0.1:${address.port}`);
    });
  });
}

function writeFixtureRun(root: string) {
  const runDir = resolve(root, '.treeseed/guarantees/runs/run-a');
  mkdirSync(resolve(runDir, 'evidence'), { recursive: true });
  mkdirSync(resolve(root, 'packages/reviewer/guarantees/reviewer/workplan'), { recursive: true });
  writeFileSync(resolve(runDir, 'evidence/log.txt'), 'line 1\nline 2\nline 3\n');
  writeFileSync(resolve(root, 'packages/reviewer/guarantees/reviewer/workplan/create-local-workplan.guarantee.yaml'), 'schemaVersion: treeseed.guarantee/v1\n');
  const report = {
    ok: false,
    runId: 'run-a',
    workspaceRoot: root,
    environment: 'local',
    filter: { ownerPackage: '@treeseed/reviewer' },
    startedAt: '2026-07-08T10:00:00.000Z',
    completedAt: '2026-07-08T10:01:00.000Z',
    outputRoot: runDir,
    plan: {
      ok: true,
      workspaceRoot: root,
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
        evidenceRequired: ['log'],
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
      steps: [{ id: 'verify', kind: 'api', status: 'failed', summary: 'Failed', evidence: ['evidence/log.txt'], diagnostics: [] }],
      evidence: ['evidence/log.txt'],
      diagnostics: [{ severity: 'error', code: 'reviewer.failed', message: 'Review failed.' }],
    }],
    diagnostics: [],
    counts: { planned: 0, passed: 0, failed: 1, skipped: 0, blocked: 0, releaseBlockingFailures: 1 },
  };
  writeFileSync(resolve(runDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(resolve(runDir, 'plan.json'), `${JSON.stringify(report.plan, null, 2)}\n`);
  writeFileSync(resolve(runDir, 'report.md'), '# Report\n');
}

async function createFixtureServer() {
  const root = mkdtempSync(resolve(tmpdir(), 'treeseed-reviewer-http-'));
  const uiRoot = resolve(root, 'ui');
  mkdirSync(uiRoot, { recursive: true });
  writeFileSync(resolve(uiRoot, 'index.html'), '<main>Reviewer</main>');
  writeFixtureRun(root);
  const completedTask: ReviewerTask = {
    id: 'task-a',
    status: 'completed',
    command: ['trsd', 'guarantees', 'run'],
    startedAt: '2026-07-08T10:00:00.000Z',
    completedAt: '2026-07-08T10:00:01.000Z',
    stdout: ['ok'],
    stderr: [],
    output: ['ok'],
    lastOutputAt: '2026-07-08T10:00:01.000Z',
  };
  const context: ReviewerServerContext = {
    workspaceRoot: root,
    uiRoot,
    version: 'test',
    tasks: new Map([[completedTask.id, completedTask]]),
  };
  const server = createServer((request, response) => {
    void handleReviewerRequest(context, request, response);
  });
  return { root, baseUrl: await listen(server) };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolvePromise) => server.close(() => resolvePromise()))));
});

describe('reviewer HTTP routes', () => {
  it('serves workspace, runs, evidence text, draft notes, task state, SSE, static UI, and workplan creation', async () => {
    const { root, baseUrl } = await createFixtureServer();

    const workspace = await fetch(`${baseUrl}/api/workspace`);
    expect(workspace.status).toBe(200);
    expect(await workspace.json()).toMatchObject({ workspaceRoot: root, packageName: '@treeseed/reviewer' });

    const runs = await fetch(`${baseUrl}/api/guarantee-runs`);
    expect(runs.status).toBe(200);
    expect((await runs.json() as { runs: Array<{ runId: string }> }).runs[0]?.runId).toBe('run-a');

    const detail = await fetch(`${baseUrl}/api/guarantee-runs/run-a`);
    expect(detail.status).toBe(200);
    expect((await detail.json() as { items: unknown[] }).items).toHaveLength(1);

    const text = await fetch(`${baseUrl}/api/evidence/text?path=${encodeURIComponent('.treeseed/guarantees/runs/run-a/evidence/log.txt')}&startLine=1&lineCount=1`);
    expect(text.status).toBe(200);
    expect(await text.json()).toMatchObject({ text: 'line 2', totalLines: 4 });

    const evidence = await fetch(`${baseUrl}/api/evidence?path=${encodeURIComponent('.treeseed/guarantees/runs/run-a/evidence/log.txt')}`);
    expect(evidence.status).toBe(200);
    expect(await evidence.text()).toContain('line 1');

    const missingEvidence = await fetch(`${baseUrl}/api/evidence?path=${encodeURIComponent('.treeseed/guarantees/runs/run-a/evidence/missing.txt')}`);
    expect(missingEvidence.status).toBe(404);

    const noteUrl = `${baseUrl}/api/review-notes/run-a/${encodeURIComponent('guarantee.reviewer.workplan.create-local-workplan.001')}`;
    const noteWrite = await fetch(noteUrl, {
      method: 'PUT',
      body: JSON.stringify({
        classification: 'ui-defect',
        priority: 'release-blocking',
        ownerPackage: '@treeseed/reviewer',
        note: 'Fix the local reviewer flow.',
        selectedEvidenceIds: [],
        includeInWorkplan: true,
      }),
    });
    expect(noteWrite.status).toBe(200);
    expect(await (await fetch(noteUrl)).json()).toMatchObject({ draft: { note: 'Fix the local reviewer flow.' } });

    const task = await fetch(`${baseUrl}/api/tasks/task-a`);
    expect(task.status).toBe(200);
    expect(await task.json()).toMatchObject({ task: { status: 'completed' } });

    const events = await fetch(`${baseUrl}/api/tasks/task-a/events`);
    expect(events.status).toBe(200);
    expect(await events.text()).toContain('task-a');

    const workplan = await fetch(`${baseUrl}/api/workplans`, {
      method: 'POST',
      body: JSON.stringify({
        runId: 'run-a',
        title: 'HTTP route workplan',
        includeGuaranteeIds: ['guarantee.reviewer.workplan.create-local-workplan.001'],
        copyRawEvidence: true,
      }),
    });
    expect(workplan.status).toBe(200);
    const payload = await workplan.json() as { workplanRoot: string; agentBriefPath: string };
    expect(existsSync(payload.agentBriefPath)).toBe(true);
    expect(readFileSync(resolve(payload.workplanRoot, 'agent-brief.md'), 'utf8')).toContain('Fix the local reviewer flow.');

    const staticPage = await fetch(`${baseUrl}/runs/run-a/review`);
    expect(staticPage.status).toBe(200);
    expect(await staticPage.text()).toContain('Reviewer');

    const missingApi = await fetch(`${baseUrl}/api/nope`);
    expect(missingApi.status).toBe(404);
  });
});
