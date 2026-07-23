import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ReviewerDraftNote } from '../../src/shared/contracts.ts';
import { createWorkplan, writeDraft } from '../../src/server/workplans.ts';

function setupWorkspace() {
  const root = mkdtempSync(resolve(tmpdir(), 'treeseed-reviewer-workplan-'));
  const runDir = resolve(root, '.treeseed/guarantees/runs/run-a');
  mkdirSync(resolve(runDir, 'evidence'), { recursive: true });
  mkdirSync(resolve(runDir, 'logs'), { recursive: true });
  mkdirSync(resolve(root, '.treeseed/scenes/runs/reviewer.workplan/run-1/playwright/screenshots'), { recursive: true });
  mkdirSync(resolve(root, '.treeseed/scenes/runs/reviewer.workplan/run-1/logs'), { recursive: true });
  mkdirSync(resolve(root, 'packages/reviewer/guarantees/reviewer/workplan/scenes'), { recursive: true });
  writeFileSync(resolve(runDir, 'evidence/screenshot.png'), 'image');
  writeFileSync(resolve(runDir, 'logs/console.log'), 'error');
  writeFileSync(resolve(root, '.treeseed/scenes/runs/reviewer.workplan/run-1/playwright/screenshots/open-entry-route.png'), 'scene image');
  writeFileSync(resolve(root, '.treeseed/scenes/runs/reviewer.workplan/run-1/logs/console.jsonl'), 'scene log');
  writeFileSync(resolve(root, 'packages/reviewer/guarantees/reviewer/workplan/create-local-workplan.guarantee.yaml'), 'schemaVersion: treeseed.guarantee/v1\n');
  writeFileSync(resolve(root, 'packages/reviewer/guarantees/reviewer/workplan/scenes/create-local-workplan.scene.yaml'), 'schemaVersion: treeseed.scene/v1\n');
  const report = {
    ok: false,
    runId: 'run-a',
    workspaceRoot: root,
    environment: 'local',
    filter: { ownerPackage: '@treeseed/reviewer', status: 'active' },
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
        gates: ['release'],
        sourcePath: 'packages/reviewer/guarantees/reviewer/workplan/create-local-workplan.guarantee.yaml',
        selected: true,
        dependency: false,
        sceneManifest: 'scenes/create-local-workplan.scene.yaml',
        apiVerifierRefs: [],
        contentVerifierRefs: [],
        auditVerifierRefs: [],
        evidenceRequired: ['screenshot'],
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
      steps: [{ id: 'scene', kind: 'scene', status: 'failed', summary: 'Scene failed', evidence: ['evidence/screenshot.png', 'logs/console.log', '.treeseed/scenes/runs/reviewer.workplan/run-1'], diagnostics: [] }],
      evidence: ['evidence/screenshot.png', '.treeseed/scenes/runs/reviewer.workplan/run-1'],
      diagnostics: [{ severity: 'error', code: 'scene.failed', message: 'Failure' }],
    }],
    diagnostics: [],
    counts: { planned: 0, passed: 0, failed: 1, skipped: 0, blocked: 0, releaseBlockingFailures: 1 },
  };
  writeFileSync(resolve(runDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(resolve(runDir, 'plan.json'), `${JSON.stringify(report.plan, null, 2)}\n`);
  writeFileSync(resolve(runDir, 'report.md'), '# report\n');
  return root;
}

describe('workplan packaging', () => {
  it('writes directives, evidence manifest, context, and agent brief', () => {
    const root = setupWorkspace();
    const draft: ReviewerDraftNote = {
      schemaVersion: 'treeseed.reviewer.draft-note/v1',
      runId: 'run-a',
      guaranteeId: 'guarantee.reviewer.workplan.create-local-workplan.001',
      updatedAt: '2026-07-08T10:02:00.000Z',
      classification: 'ui-defect',
      priority: 'release-blocking',
      ownerPackage: '@treeseed/reviewer',
      note: 'The package button is not visible.',
      expectedBehavior: 'The package button should remain visible at the end of review.',
      selectedEvidenceIds: [],
      includeInWorkplan: true,
    };
    writeDraft(root, draft);
    const result = createWorkplan(root, {
      runId: 'run-a',
      title: 'Reviewer package button',
      includeGuaranteeIds: ['guarantee.reviewer.workplan.create-local-workplan.001'],
      copyRawEvidence: true,
    });
    expect(result.directiveCount).toBe(1);
    expect(result.evidenceCount).toBeGreaterThan(0);
    expect(existsSync(result.workplanYamlPath)).toBe(true);
    expect(existsSync(result.agentBriefPath)).toBe(true);
    expect(existsSync(resolve(result.workplanRoot, 'evidence/manifest.json'))).toBe(true);
    const manifest = JSON.parse(readFileSync(resolve(result.workplanRoot, 'evidence/manifest.json'), 'utf8')) as { evidence: Array<{ copiedPath?: string; exists: boolean }> };
    expect(manifest.evidence.some((entry) => entry.exists && entry.copiedPath?.includes('open-entry-route'))).toBe(true);
    expect(manifest.evidence.some((entry) => entry.exists && entry.copiedPath?.includes('console'))).toBe(true);
    expect(readFileSync(result.agentBriefPath, 'utf8')).toContain('The package button is not visible.');
  });
});
