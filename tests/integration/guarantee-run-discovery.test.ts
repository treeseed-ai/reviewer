import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { commandArgsForGuarantees, discoverGuaranteeRuns, loadGuaranteeReviewRun } from '../../src/server/guarantee-runs.ts';
import type { GuaranteeRunReport } from '@treeseed/sdk/guarantees';

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
    expect(args).toContain('--include-planned');
    expect(args).toContain('--scene-artifacts');
    expect(args).toContain('full');
    expect(args.filter((entry) => entry === '--id')).toHaveLength(2);
  });
});
