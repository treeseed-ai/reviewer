import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, extname, relative, resolve } from 'node:path';
import type {
  ReviewerDirectiveClassification,
  ReviewerDirectivePriority,
  ReviewerEvidenceItem,
  ReviewerGuaranteeReviewItem,
  ReviewerGuaranteeRunSummary,
} from './contracts.ts';
import type { GuaranteePlanEntry, GuaranteePlanReport, GuaranteeRunReport, GuaranteeRunResult } from '@treeseed/sdk/guarantees';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif']);
const LOG_EXTENSIONS = new Set(['.log', '.txt', '.jsonl', '.out', '.err']);
const JSON_EXTENSIONS = new Set(['.json']);
const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mov']);

export function inferEvidenceKind(path: string): ReviewerEvidenceItem['kind'] {
  const lower = extname(path).toLowerCase();
  if (IMAGE_EXTENSIONS.has(lower)) return 'screenshot';
  if (LOG_EXTENSIONS.has(lower)) return 'log';
  if (JSON_EXTENSIONS.has(lower)) return basename(path).includes('manifest') ? 'manifest' : 'json';
  if (MARKDOWN_EXTENSIONS.has(lower)) return 'markdown';
  if (VIDEO_EXTENSIONS.has(lower)) return 'video';
  if (path.includes('trace')) return 'trace';
  if (path.endsWith('.csv')) return 'csv';
  if (path.includes('log')) return 'log';
  return 'unknown';
}

function isViewportScreenshotPath(path: string) {
  return path.replace(/\\/gu, '/').includes('/playwright/screenshots/viewport/');
}

export function releaseBlockingPlanEntry(entry?: GuaranteePlanEntry) {
  return Boolean(entry && (entry.gates.includes('release') || entry.gates.includes('security') || entry.gates.includes('migration')));
}

export function recommendedPriority(result: GuaranteeRunResult, planEntry?: GuaranteePlanEntry): ReviewerDirectivePriority {
  if ((result.status === 'failed' || result.status === 'blocked') && releaseBlockingPlanEntry(planEntry)) return 'release-blocking';
  if ((result.status === 'failed' || result.status === 'blocked') && result.selected) return 'high';
  if (result.status === 'failed' || result.status === 'blocked') return 'high';
  if (result.status === 'skipped') return 'medium';
  return 'low';
}

export function recommendedClassification(result: GuaranteeRunResult): ReviewerDirectiveClassification {
  if (result.status === 'passed') return 'ux-improvement';
  if (result.status === 'skipped') return 'investigate';
  if (result.diagnostics.some((entry) => /fixture|environment|local_dev|seed|auth/iu.test(`${entry.code} ${entry.message}`))) return 'fixture-environment-defect';
  if (result.steps.some((step) => step.kind === 'scene') || result.evidence.some((entry) => inferEvidenceKind(entry) === 'screenshot')) return 'ui-defect';
  return 'product-defect';
}

export function rerunCommandFor(result: GuaranteeRunResult, environment: string) {
  return `npm run guarantees:run -- --ids ${result.id} --environment ${environment}`;
}

function evidenceAbsolutePath(workspaceRoot: string, runOutputRoot: string, path: string) {
  if (path.startsWith('/')) return path;
  const fromWorkspace = resolve(workspaceRoot, path);
  if (existsSync(fromWorkspace)) return fromWorkspace;
  return resolve(runOutputRoot, path);
}

function evidenceLabel(path: string, absolutePath: string, stepId?: string) {
  const normalized = path.replace(/\\/gu, '/');
  const parts = normalized.split('/').filter(Boolean);
  const sceneRunIndex = parts.findIndex((part, index) => part === 'runs' && parts[index - 1] === 'scenes');
  const label =
    sceneRunIndex >= 0 && parts.length > sceneRunIndex + 2
      ? parts.slice(sceneRunIndex + 2).join('/')
      : parts.length > 1
        ? parts.slice(-3).join('/')
        : basename(path);
  return stepId ? `${stepId}: ${label}` : label;
}

function hashEvidenceFile(absolutePath: string) {
  return createHash('sha256').update(readFileSync(absolutePath)).digest('hex');
}

function markDuplicateEvidence(items: ReviewerEvidenceItem[]) {
  const firstByHash = new Map<string, ReviewerEvidenceItem>();
  const duplicateCounts = new Map<string, number>();
  for (const item of items) {
    if (!item.exists || item.kind !== 'screenshot') continue;
    const hash = hashEvidenceFile(item.absolutePath);
    item.contentHash = hash;
    const first = firstByHash.get(hash);
    if (first) {
      item.duplicateOf = first.id;
      duplicateCounts.set(first.id, (duplicateCounts.get(first.id) ?? 0) + 1);
      continue;
    }
    firstByHash.set(hash, item);
  }
  for (const item of items) {
    const count = duplicateCounts.get(item.id);
    if (count) item.duplicateCount = count;
  }
  return items;
}

function markRunDuplicateScreenshots(items: ReviewerGuaranteeReviewItem[]) {
  const byHash = new Map<string, Array<{ guaranteeId: string; evidence: ReviewerEvidenceItem }>>();
  for (const item of items) {
    for (const evidence of item.evidence) {
      if (evidence.kind !== 'screenshot' || !evidence.contentHash) continue;
      const group = byHash.get(evidence.contentHash) ?? [];
      group.push({ guaranteeId: item.guaranteeId, evidence });
      byHash.set(evidence.contentHash, group);
    }
  }
  for (const group of byHash.values()) {
    const guaranteeCount = new Set(group.map((entry) => entry.guaranteeId)).size;
    if (group.length < 2 && guaranteeCount < 2) continue;
    for (const entry of group) {
      entry.evidence.runDuplicateEvidenceCount = group.length - 1;
      entry.evidence.runDuplicateGuaranteeCount = guaranteeCount;
    }
  }
  return items;
}

function expandDirectoryEvidence(input: { workspaceRoot: string; runOutputRoot: string; path: string; absolutePath: string }) {
	const files: string[] = [];
	const screenshotOrder = new Map<string, number>();
	const runJsonPath = resolve(input.absolutePath, 'run.json');
	if (existsSync(runJsonPath)) {
		try {
			const run = JSON.parse(readFileSync(runJsonPath, 'utf8')) as { steps?: Array<{ screenshotPath?: string | null }> };
			for (const [index, step] of (run.steps ?? []).entries()) {
				if (step.screenshotPath) screenshotOrder.set(resolve(step.screenshotPath), index);
			}
		} catch {
			// Ignore malformed scene run metadata; evidence still sorts by kind and path.
		}
	}
	const visit = (directory: string, depth: number) => {
    if (depth > 5 || files.length >= 500) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolute, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (isViewportScreenshotPath(absolute)) continue;
      const kind = inferEvidenceKind(absolute);
      if (kind === 'screenshot' || kind === 'log' || kind === 'json' || kind === 'markdown' || kind === 'video' || kind === 'trace') {
        files.push(absolute);
      }
    }
  };
  visit(input.absolutePath, 0);
	return files
		.sort((a, b) => {
			const kindRank = (path: string) => {
				const kind = inferEvidenceKind(path);
				if (kind === 'screenshot') return 0;
        if (kind === 'json') return 1;
        if (kind === 'log') return 2;
        if (kind === 'markdown') return 3;
				if (kind === 'video') return 4;
				return 5;
			};
			const orderA = screenshotOrder.get(resolve(a));
			const orderB = screenshotOrder.get(resolve(b));
			if (typeof orderA === 'number' || typeof orderB === 'number') return (orderA ?? Number.MAX_SAFE_INTEGER) - (orderB ?? Number.MAX_SAFE_INTEGER);
			return kindRank(a) - kindRank(b) || a.localeCompare(b);
		})
    .map((absolute) => relative(input.workspaceRoot, absolute).replace(/\\/gu, '/'));
}

export function evidenceItemsFor(input: { workspaceRoot: string; runOutputRoot: string; result: GuaranteeRunResult }): ReviewerEvidenceItem[] {
  const items: ReviewerEvidenceItem[] = [];
  let index = 0;
  const push = (source: ReviewerEvidenceItem['source'], path: string, stepId?: string) => {
    const absolutePath = evidenceAbsolutePath(input.workspaceRoot, input.runOutputRoot, path);
    const exists = existsSync(absolutePath);
    if (exists && statSync(absolutePath).isDirectory()) {
      for (const expandedPath of expandDirectoryEvidence({ workspaceRoot: input.workspaceRoot, runOutputRoot: input.runOutputRoot, path, absolutePath })) {
        push(source, expandedPath, stepId);
      }
      return;
    }
    const kind = inferEvidenceKind(path);
    items.push({
      id: `${input.result.id}-${String(index += 1).padStart(3, '0')}`,
      kind,
      path,
      absolutePath,
      exists,
      source,
      ...(stepId ? { stepId } : {}),
      label: evidenceLabel(path, absolutePath, stepId),
      ...(exists && statSync(absolutePath).isFile() ? { byteSize: statSync(absolutePath).size } : {}),
    });
  };
  for (const path of input.result.evidence) push('result', path);
  for (const step of input.result.steps) {
    for (const path of step.evidence ?? []) push('step', path, step.id);
  }
  const seen = new Set<string>();
  return markDuplicateEvidence(items.filter((item) => {
    const key = item.absolutePath;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }));
}

export function sortReviewResults(report: GuaranteeRunReport, plan: GuaranteePlanReport | null) {
  const planEntries = new Map((plan?.entries ?? []).map((entry) => [entry.id, entry]));
  const rank = (result: GuaranteeRunResult) => {
    const entry = planEntries.get(result.id);
    if ((result.status === 'failed' || result.status === 'blocked') && releaseBlockingPlanEntry(entry)) return 0;
    if (result.status === 'blocked' && result.selected) return 1;
    if (result.status === 'failed' && result.selected) return 2;
    if (result.status === 'failed') return 3;
    if (result.status === 'skipped' && result.selected) return 4;
    if (result.status === 'passed' && result.selected) return 5;
    return 6;
  };
  return [...report.results].sort((a, b) => rank(a) - rank(b) || (a.journeyIndex ?? 9999) - (b.journeyIndex ?? 9999) || a.id.localeCompare(b.id));
}

export function buildReviewItems(input: {
  workspaceRoot: string;
  run: ReviewerGuaranteeRunSummary;
  report: GuaranteeRunReport;
  plan: GuaranteePlanReport | null;
}): ReviewerGuaranteeReviewItem[] {
  const planEntries = new Map((input.plan?.entries ?? []).map((entry) => [entry.id, entry]));
  const items = sortReviewResults(input.report, input.plan).map((result, index) => {
    const planEntry = planEntries.get(result.id);
    const evidence = evidenceItemsFor({ workspaceRoot: input.workspaceRoot, runOutputRoot: input.run.outputRoot, result });
    const primaryScreenshot = evidence.find((item) => item.kind === 'screenshot' && item.exists && !item.duplicateOf)
      ?? evidence.find((item) => item.kind === 'screenshot' && item.exists);
    const primaryLog = evidence.find((item) => item.kind === 'log' && item.exists) ?? evidence.find((item) => item.kind === 'json' && item.exists);
    const failedSteps = result.steps.filter((step) => step.status === 'failed' || step.status === 'blocked');
    return {
      id: result.id,
      index,
      guaranteeId: result.id,
      journey: result.journey,
      ownerPackage: result.ownerPackage,
      type: result.type,
      subtype: result.subtype,
      status: result.status,
      selected: result.selected,
      dependency: result.dependency,
      releaseBlocking: releaseBlockingPlanEntry(planEntry),
      sourcePath: result.sourcePath,
      summary: failedSteps[0]?.summary ?? result.steps[0]?.summary ?? result.journey,
      steps: result.steps,
      diagnostics: result.diagnostics,
      evidence,
      ...(primaryScreenshot ? { primaryScreenshot } : {}),
      ...(primaryLog ? { primaryLog } : {}),
      recommendedClassification: recommendedClassification(result),
      recommendedPriority: recommendedPriority(result, planEntry),
      rerunCommand: rerunCommandFor(result, input.report.environment),
    };
  });
  return markRunDuplicateScreenshots(items);
}
