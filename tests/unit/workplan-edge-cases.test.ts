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

