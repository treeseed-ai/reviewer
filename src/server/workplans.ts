import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import type {
  ReviewerCopiedEvidence,
  ReviewerCreateWorkplanRequest,
  ReviewerDraftNote,
  ReviewerEvidenceItem,
  ReviewerWorkplanCreateResponse,
  TreeseedReviewerDirective,
  TreeseedReviewerDirectiveSummary,
  TreeseedReviewerWorkplan,
} from '../shared/contracts.ts';
import { REVIEWER_DIRECTIVE_CONSTRAINTS, directiveTypeFor } from '../shared/workplan.ts';
import { loadGuaranteeReviewRun } from './guarantee-runs.ts';
import { assertInsideWorkspace, fileExists, safeSlug, workspaceRelative } from './workspace.ts';

function json<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

export function draftPath(workspaceRoot: string, runId: string, guaranteeId: string) {
  return resolve(workspaceRoot, '.treeseed', 'reviewer', 'drafts', safeSlug(runId), `${safeSlug(guaranteeId)}.json`);
}

export function readDraft(workspaceRoot: string, runId: string, guaranteeId: string): ReviewerDraftNote | null {
  const path = draftPath(workspaceRoot, runId, guaranteeId);
  if (!fileExists(path)) return null;
  return json<ReviewerDraftNote>(path);
}

export function writeDraft(workspaceRoot: string, draft: ReviewerDraftNote) {
  const path = draftPath(workspaceRoot, draft.runId, draft.guaranteeId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ ...draft, updatedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8');
  return path;
}

function sha256(path: string) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function copyInto(source: string, destination: string) {
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
}

function workplanIdFor(title: string) {
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
  return `${stamp}-${safeSlug(title).slice(0, 48)}`;
}

function evidenceDestination(input: { workplanRoot: string; directiveId: string; item: ReviewerEvidenceItem }) {
  const suffix = safeSlug(input.item.label);
  return resolve(input.workplanRoot, 'evidence', 'raw', input.directiveId, `${input.item.id}-${suffix}`);
}

function copyEvidence(input: {
  workplanRoot: string;
  directiveId: string;
  guaranteeId: string;
  item: ReviewerEvidenceItem;
}): ReviewerCopiedEvidence {
  const sourcePath = input.item.absolutePath;
  const exists = existsSync(sourcePath) && statSync(sourcePath).isFile();
  const destination = evidenceDestination({ workplanRoot: input.workplanRoot, directiveId: input.directiveId, item: input.item });
  if (exists) copyInto(sourcePath, destination);
  return {
    id: input.item.id,
    directiveId: input.directiveId,
    guaranteeId: input.guaranteeId,
    kind: input.item.kind,
    sourcePath,
    ...(exists ? { copiedPath: workspaceRelative(input.workplanRoot, destination), sha256: sha256(sourcePath), byteSize: statSync(sourcePath).size } : {}),
    exists,
    sensitivity: 'local-private',
  };
}

function verifierRefs(item: import('../shared/contracts.ts').ReviewerGuaranteeReviewItem) {
  return item.steps.map((step) => step.ref).filter((ref): ref is string => Boolean(ref));
}

function sceneRefs(item: import('../shared/contracts.ts').ReviewerGuaranteeReviewItem) {
  return item.steps.filter((step) => step.kind === 'scene').map((step) => step.ref ?? step.id);
}

function directiveMarkdown(directive: TreeseedReviewerDirective) {
  const copied = directive.evidence.copied.map((entry) => `- ${entry.kind}: ${entry.copiedPath ?? entry.sourcePath}${entry.exists ? '' : ' (missing)'}`).join('\n') || '- No copied evidence.';
  return [
    `# ${directive.order}. ${directive.source.guaranteeId}`,
    '',
    `Owner: ${directive.source.ownerPackage}`,
    `Priority: ${directive.priority}`,
    `Classification: ${directive.reviewer.classification}`,
    `Status: ${directive.source.status}`,
    '',
    '## Reviewer Note',
    '',
    directive.reviewer.note || '(No note supplied.)',
    '',
    '## Expected Behavior',
    '',
    directive.reviewer.expectedBehavior || 'The guarantee should pass without weakening the product promise.',
    '',
    '## Evidence',
    '',
    copied,
    '',
    '## Acceptance',
    '',
    directive.acceptance.rerunCommands.map((command) => `- \`${command}\``).join('\n'),
    '',
  ].join('\n');
}

function workplanMarkdown(workplan: TreeseedReviewerWorkplan, directives: TreeseedReviewerDirective[]) {
  return [
    `# ${workplan.title}`,
    '',
    `Workplan: ${workplan.id}`,
    `Run: ${workplan.source.runId}`,
    `Environment: ${workplan.source.environment}`,
    '',
    `Directives: ${workplan.summary.directiveCount}`,
    `Release-blocking: ${workplan.summary.releaseBlockingDirectiveCount}`,
    `Owner packages: ${workplan.summary.ownerPackages.join(', ')}`,
    '',
    '## Directive Queue',
    '',
    ...directives.map((directive) => [
      `### ${directive.order}. ${directive.source.guaranteeId}`,
      '',
      `- Owner: ${directive.source.ownerPackage}`,
      `- Priority: ${directive.priority}`,
      `- Classification: ${directive.reviewer.classification}`,
      `- Note: ${directive.reviewer.note || '(No note supplied.)'}`,
      `- Rerun: \`${directive.acceptance.rerunCommands[0]}\``,
      '',
    ].join('\n')),
  ].join('\n');
}

function agentBrief(workplan: TreeseedReviewerWorkplan, directives: TreeseedReviewerDirective[]) {
  const lines = [
    `# Codex Workplan: ${workplan.title}`,
    '',
    `This workplan was generated from TreeSeed guarantee run ${workplan.source.runId} in ${workplan.source.environment}. Work through the directives in order, use the attached local evidence, and verify each fix with its focused rerun command before broad checks.`,
    '',
    '## Global Constraints',
    '',
    '- Do not weaken active guarantees unless the directive classification explicitly permits guarantee/test repair.',
    '- Prefer package-local standalone fixes.',
    '- Preserve TreeSeed package boundaries.',
    '- Run focused verification first.',
    '',
    '## Directive Queue',
    '',
  ];
  for (const directive of directives) {
    lines.push(
      `### ${directive.order}. ${directive.source.guaranteeId}`,
      '',
      `Owner package: ${directive.source.ownerPackage}`,
      `Status: ${directive.source.status}`,
      `Priority: ${directive.priority}`,
      `Classification: ${directive.reviewer.classification}`,
      '',
      'Reviewer note:',
      '',
      directive.reviewer.note || '(No note supplied.)',
      '',
      'Expected behavior:',
      '',
      directive.reviewer.expectedBehavior || 'The guarantee should pass without weakening the product promise.',
      '',
      'Evidence:',
      ...directive.evidence.copied.map((entry) => `- ${entry.copiedPath ?? entry.sourcePath}${entry.exists ? '' : ' (missing)'}`),
      '',
      `Rerun: \`${directive.acceptance.rerunCommands[0]}\``,
      '',
      'Definition of done:',
      '- The focused guarantee passes.',
      '- Attached scene/log evidence no longer shows the reviewed failure.',
      '- No new console/request/type errors are introduced.',
      '',
    );
  }
  return lines.join('\n');
}

function commandScript(commands: string[]) {
  return ['#!/usr/bin/env bash', 'set -euo pipefail', ...commands].join('\n') + '\n';
}

function copyContext(input: { workspaceRoot: string; workplanRoot: string; runOutputRoot: string; reportPath: string; planPath?: string; markdownPath?: string; includeSourcePaths: string[]; sceneManifestPaths: string[] }) {
  const contextRoot = resolve(input.workplanRoot, 'context');
  mkdirSync(contextRoot, { recursive: true });
  copyInto(input.reportPath, resolve(contextRoot, 'guarantee-report.json'));
  if (input.planPath && fileExists(input.planPath)) copyInto(input.planPath, resolve(contextRoot, 'guarantee-plan.json'));
  if (input.markdownPath && fileExists(input.markdownPath)) copyInto(input.markdownPath, resolve(contextRoot, 'guarantee-report.md'));
  for (const source of input.includeSourcePaths) {
    const absolute = assertInsideWorkspace(input.workspaceRoot, resolve(input.workspaceRoot, source));
    if (fileExists(absolute)) copyInto(absolute, resolve(contextRoot, 'guarantee-manifests', source.split(sep).join('/')));
  }
  for (const source of input.sceneManifestPaths) {
    const absolute = assertInsideWorkspace(input.workspaceRoot, resolve(input.workspaceRoot, source));
    if (!fileExists(absolute)) continue;
    copyInto(absolute, resolve(contextRoot, 'scene-manifests', source.split(sep).join('/')));
  }
}

export function createWorkplan(workspaceRoot: string, request: ReviewerCreateWorkplanRequest): ReviewerWorkplanCreateResponse {
  const reviewRun = loadGuaranteeReviewRun(workspaceRoot, request.runId);
  const selected = reviewRun.items.filter((item) => request.includeGuaranteeIds.includes(item.guaranteeId));
  if (selected.length === 0) throw new Error('No guarantee review items were selected for the workplan.');
  const workplanId = workplanIdFor(request.title);
  const workplanRoot = resolve(workspaceRoot, '.treeseed', 'workplans', workplanId);
  mkdirSync(workplanRoot, { recursive: true });
  const directives: TreeseedReviewerDirective[] = [];
  const evidence: ReviewerCopiedEvidence[] = [];
  let order = 0;
  for (const item of selected) {
    const draft = readDraft(workspaceRoot, reviewRun.run.runId, item.guaranteeId);
    const directiveId = `${String(order + 1).padStart(3, '0')}-${safeSlug(item.guaranteeId)}`;
    const copied = item.evidence.map((evidenceItem) => copyEvidence({ workplanRoot, directiveId, guaranteeId: item.guaranteeId, item: evidenceItem }));
    evidence.push(...copied);
    const directive: TreeseedReviewerDirective = {
      schemaVersion: 'treeseed.reviewer.directive/v1',
      id: directiveId,
      order: order += 1,
      type: directiveTypeFor(draft?.classification ?? item.recommendedClassification),
      priority: draft?.priority ?? item.recommendedPriority,
      source: {
        runId: reviewRun.run.runId,
        guaranteeId: item.guaranteeId,
        ownerPackage: draft?.ownerPackage ?? item.ownerPackage,
        type: item.type,
        subtype: item.subtype,
        journey: item.journey,
        status: item.status,
        sourcePath: item.sourcePath,
        verifierRefs: verifierRefs(item),
        sceneRefs: sceneRefs(item),
        failedStepIds: item.steps.filter((step) => step.status === 'failed' || step.status === 'blocked').map((step) => step.id),
      },
      reviewer: {
        note: draft?.note ?? item.summary,
        ...(draft?.expectedBehavior ? { expectedBehavior: draft.expectedBehavior } : {}),
        classification: draft?.classification ?? item.recommendedClassification,
      },
      evidence: {
        copied,
        sourcePaths: item.evidence.map((entry) => entry.absolutePath),
        diagnostics: item.diagnostics,
      },
      constraints: REVIEWER_DIRECTIVE_CONSTRAINTS,
      acceptance: {
        rerunCommands: [item.rerunCommand],
        requiredOutcome: ['guarantee passes', 'attached scene or verifier step passes', 'no new console or request errors'],
      },
    };
    directives.push(directive);
    const yamlPath = resolve(workplanRoot, 'directives', `${directiveId}.directive.yaml`);
    const markdownPath = resolve(workplanRoot, 'directives', `${directiveId}.md`);
    mkdirSync(dirname(yamlPath), { recursive: true });
    writeFileSync(yamlPath, stringifyYaml(directive, { lineWidth: 0 }), 'utf8');
    writeFileSync(markdownPath, directiveMarkdown(directive), 'utf8');
  }
  const statuses: Record<string, number> = {};
  for (const directive of directives) statuses[directive.source.status] = (statuses[directive.source.status] ?? 0) + 1;
  const summaries: TreeseedReviewerDirectiveSummary[] = directives.map((directive) => ({
    id: directive.id,
    order: directive.order,
    guaranteeId: directive.source.guaranteeId,
    ownerPackage: directive.source.ownerPackage,
    type: directive.type,
    priority: directive.priority,
    classification: directive.reviewer.classification,
    yamlPath: `directives/${directive.id}.directive.yaml`,
    markdownPath: `directives/${directive.id}.md`,
  }));
  const workplan: TreeseedReviewerWorkplan = {
    schemaVersion: 'treeseed.reviewer.workplan/v1',
    id: workplanId,
    title: request.title,
    createdAt: new Date().toISOString(),
    workspaceRoot,
    source: {
      runId: reviewRun.run.runId,
      runOutputRoot: reviewRun.run.outputRoot,
      reportPath: reviewRun.run.reportPath,
      environment: reviewRun.run.environment,
      filter: reviewRun.run.filter,
    },
    summary: {
      directiveCount: directives.length,
      releaseBlockingDirectiveCount: directives.filter((directive) => directive.priority === 'release-blocking').length,
      ownerPackages: [...new Set(directives.map((directive) => directive.source.ownerPackage))].sort(),
      statuses,
    },
    directives: summaries,
    evidenceManifest: 'evidence/manifest.json',
    commands: {
      reproduce: 'commands/reproduce.sh',
      verify: 'commands/verify.sh',
    },
  };
  const planEntries = new Map((reviewRun.plan?.entries ?? []).map((entry) => [entry.id, entry]));
  copyContext({
    workspaceRoot,
    workplanRoot,
    runOutputRoot: reviewRun.run.outputRoot,
    reportPath: reviewRun.run.reportPath,
    planPath: reviewRun.run.planPath,
    markdownPath: reviewRun.run.markdownPath,
    includeSourcePaths: selected.map((item) => item.sourcePath),
    sceneManifestPaths: selected.map((item) => {
      const entry = planEntries.get(item.guaranteeId);
      if (!entry?.sceneManifest) return '';
      return resolve(dirname(resolve(workspaceRoot, item.sourcePath)), entry.sceneManifest);
    }).filter(Boolean).map((path) => relative(workspaceRoot, path)),
  });
  mkdirSync(resolve(workplanRoot, 'evidence'), { recursive: true });
  writeFileSync(resolve(workplanRoot, 'evidence', 'manifest.json'), `${JSON.stringify({ schemaVersion: 'treeseed.reviewer.evidence-manifest/v1', generatedAt: new Date().toISOString(), evidence }, null, 2)}\n`, 'utf8');
  writeFileSync(resolve(workplanRoot, 'workplan.yaml'), stringifyYaml(workplan, { lineWidth: 0 }), 'utf8');
  writeFileSync(resolve(workplanRoot, 'workplan.md'), workplanMarkdown(workplan, directives), 'utf8');
  writeFileSync(resolve(workplanRoot, 'agent-brief.md'), agentBrief(workplan, directives), 'utf8');
  mkdirSync(resolve(workplanRoot, 'commands'), { recursive: true });
  writeFileSync(resolve(workplanRoot, 'commands', 'reproduce.sh'), commandScript(directives.map((directive) => directive.acceptance.rerunCommands[0]!).filter(Boolean)), 'utf8');
  writeFileSync(resolve(workplanRoot, 'commands', 'verify.sh'), commandScript([...new Set(directives.map((directive) => directive.acceptance.rerunCommands[0]!).filter(Boolean))]), 'utf8');
  return {
    workplanId,
    workplanRoot,
    workplanYamlPath: resolve(workplanRoot, 'workplan.yaml'),
    workplanMarkdownPath: resolve(workplanRoot, 'workplan.md'),
    agentBriefPath: resolve(workplanRoot, 'agent-brief.md'),
    directiveCount: directives.length,
    evidenceCount: evidence.length,
  };
}
