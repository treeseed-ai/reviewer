import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import type {
  ReviewerCommandResult,
  ReviewerGuaranteeCatalogEntry,
  ReviewerGuaranteePlanRequest,
  ReviewerGuaranteeReviewRun,
  ReviewerGuaranteeRunRequest,
  ReviewerGuaranteeRunSummary,
  ReviewerRunKind,
  ReviewerRunPaths,
  ReviewerTask,
} from '../shared/contracts.ts';
import { buildReviewItems } from '../shared/guarantee-review.ts';
import type { GuaranteePlanReport, GuaranteeRunReport } from '@treeseed/sdk/guarantees';
import { discoverGuarantees } from '@treeseed/sdk/guarantees';
import { assertInsideWorkspace, directoryExists, fileExists } from './workspace.ts';

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function runPaths(workspaceRoot: string, kind: ReviewerRunKind, runId: string): ReviewerRunPaths {
  const outputRoot = resolve(workspaceRoot, '.treeseed', 'guarantees', kind === 'release' ? 'release' : 'runs', runId);
  return {
    runId,
    kind,
    outputRoot,
    reportPath: resolve(outputRoot, 'report.json'),
    planPath: resolve(outputRoot, 'plan.json'),
    markdownPath: resolve(outputRoot, 'report.md'),
    generatedCsvPath: resolve(outputRoot, 'generated.csv'),
  };
}

function summaryFromReport(paths: ReviewerRunPaths, report: GuaranteeRunReport): ReviewerGuaranteeRunSummary {
  return {
    runId: report.runId || paths.runId,
    kind: paths.kind,
    outputRoot: paths.outputRoot,
    reportPath: paths.reportPath,
    ...(fileExists(paths.planPath) ? { planPath: paths.planPath } : {}),
    ...(fileExists(paths.markdownPath) ? { markdownPath: paths.markdownPath } : {}),
    ...(fileExists(paths.generatedCsvPath) ? { generatedCsvPath: paths.generatedCsvPath } : {}),
    environment: report.environment,
    startedAt: report.startedAt,
    completedAt: report.completedAt,
    ok: report.ok,
    filter: report.filter,
    counts: report.counts,
  };
}

export function discoverGuaranteeRuns(workspaceRoot: string): ReviewerGuaranteeRunSummary[] {
  const out: ReviewerGuaranteeRunSummary[] = [];
  for (const kind of ['local', 'release'] as const) {
    const root = resolve(workspaceRoot, '.treeseed', 'guarantees', kind === 'release' ? 'release' : 'runs');
    if (!directoryExists(root)) continue;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const paths = runPaths(workspaceRoot, kind, entry.name);
      if (!fileExists(paths.reportPath)) continue;
      try {
        out.push(summaryFromReport(paths, readJson<GuaranteeRunReport>(paths.reportPath)));
      } catch {
        // Ignore malformed run folders in the selector.
      }
    }
  }
  return out.sort((a, b) => {
    const aBad = Number(a.counts.releaseBlockingFailures > 0) + Number(a.counts.failed > 0 || a.counts.blocked > 0);
    const bBad = Number(b.counts.releaseBlockingFailures > 0) + Number(b.counts.failed > 0 || b.counts.blocked > 0);
    if (aBad !== bBad) return bBad - aBad;
    return Date.parse(b.completedAt ?? b.startedAt) - Date.parse(a.completedAt ?? a.startedAt);
  });
}

export function discoverGuaranteeCatalog(workspaceRoot: string): ReviewerGuaranteeCatalogEntry[] {
  const registry = discoverGuarantees({ workspaceRoot });
  return registry.guarantees
    .filter((entry) => entry.manifest)
    .map((entry) => {
      const manifest = entry.manifest!;
      return {
        id: manifest.id,
        journey: manifest.journey,
        ownerPackage: manifest.ownerPackage,
        type: manifest.type,
        subtype: manifest.subtype,
        status: manifest.status,
        gates: manifest.gates,
        sourcePath: entry.relativePath,
        label: `${manifest.journey} — ${manifest.ownerPackage} / ${manifest.type}.${manifest.subtype} (${manifest.status})`,
      };
    })
    .sort((a, b) => {
      const aActive = a.status === 'active' ? 0 : 1;
      const bActive = b.status === 'active' ? 0 : 1;
      return aActive - bActive || a.ownerPackage.localeCompare(b.ownerPackage) || a.journey.localeCompare(b.journey);
    });
}

export function loadGuaranteeReviewRun(workspaceRoot: string, runIdOrPath: string): ReviewerGuaranteeReviewRun {
  const candidates = runIdOrPath.includes('/') || runIdOrPath.includes('\\')
    ? [assertInsideWorkspace(workspaceRoot, resolve(workspaceRoot, runIdOrPath))]
    : [
      runPaths(workspaceRoot, 'local', runIdOrPath).outputRoot,
      runPaths(workspaceRoot, 'release', runIdOrPath).outputRoot,
    ];
  const outputRoot = candidates.find((candidate) => fileExists(resolve(candidate, 'report.json')));
  if (!outputRoot) throw new Error(`Guarantee run not found: ${runIdOrPath}`);
  assertInsideWorkspace(workspaceRoot, outputRoot);
  const kind: ReviewerRunKind = outputRoot.includes('/release/') ? 'release' : 'local';
  const paths: ReviewerRunPaths = {
    runId: basename(outputRoot),
    kind,
    outputRoot,
    reportPath: resolve(outputRoot, 'report.json'),
    planPath: resolve(outputRoot, 'plan.json'),
    markdownPath: resolve(outputRoot, 'report.md'),
    generatedCsvPath: resolve(outputRoot, 'generated.csv'),
  };
  const report = readJson<GuaranteeRunReport>(paths.reportPath);
  const plan = fileExists(paths.planPath) ? readJson<GuaranteePlanReport>(paths.planPath) : null;
  const run = summaryFromReport(paths, report);
  return {
    run,
    report,
    plan,
    items: buildReviewItems({ workspaceRoot, run, report, plan }),
  };
}

function platformGuaranteeScript(workspaceRoot: string, action: 'plan' | 'run') {
  const platformRoot = process.env.TREESEED_PLATFORM_WORKSPACE?.trim() || workspaceRoot;
  return resolve(platformRoot, 'scripts', action === 'plan' ? 'plan-composition-guarantees.mjs' : 'run-composition-guarantees.mjs');
}

export function commandArgsForGuarantees(action: 'plan' | 'run', request: ReviewerGuaranteePlanRequest | ReviewerGuaranteeRunRequest, workspaceRoot = process.cwd()) {
  const args = [process.execPath, platformGuaranteeScript(workspaceRoot, action), '--environment', request.environment];
  const filter = request.filter ?? {};
  if (filter.ownerPackage) args.push('--guarantee-owner-package', String(filter.ownerPackage));
  if (filter.type) args.push('--types', String(filter.type));
  if (filter.subtype) args.push('--subtypes', String(filter.subtype));
  if (filter.gate) args.push('--gates', String(filter.gate));
  if (filter.status) args.push('--statuses', String(filter.status));
  else if (request.includePlanned) args.push('--statuses', 'active,planned');
  if (Array.isArray(filter.ids) && filter.ids.length) args.push('--ids', filter.ids.map(String).join(','));
  if (Array.isArray(filter.journeyIndexes) && filter.journeyIndexes.length) args.push('--journey-indexes', filter.journeyIndexes.map(String).join(','));
  if (request.includeDependencies === false) args.push('--no-dependencies');
  if (request.device) args.push('--device', request.device);
  if (action === 'run') {
    const run = request as ReviewerGuaranteeRunRequest;
    if (run.record) args.push('--record');
    if (run.sceneArtifacts) args.push('--scene-artifacts', run.sceneArtifacts);
    if (run.evidenceTarget) args.push('--evidence-target', run.evidenceTarget);
  }
  return args;
}

function parseJsonReport(stdout: string) {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    const start = trimmed.lastIndexOf('\n{');
    if (start >= 0) return JSON.parse(trimmed.slice(start + 1)) as unknown;
    return undefined;
  }
}

export function resolveCommand(workspaceRoot: string, command: string) {
  if (command === process.execPath) return command;
  return resolve(workspaceRoot, command);
}

function timestamp() {
  return new Date().toISOString();
}

function appendTaskOutput(task: ReviewerTask, chunk: string) {
  task.output.push(chunk);
  task.lastOutputAt = timestamp();
}

function appendTaskLine(task: ReviewerTask, line: string) {
  appendTaskOutput(task, `[reviewer ${timestamp()}] ${line}\n`);
}

export function runGuaranteeCommand(workspaceRoot: string, request: ReviewerGuaranteePlanRequest, action?: 'plan'): Promise<ReviewerCommandResult>;
export function runGuaranteeCommand(workspaceRoot: string, request: ReviewerGuaranteeRunRequest, action: 'run'): Promise<ReviewerCommandResult>;
export function runGuaranteeCommand(workspaceRoot: string, request: ReviewerGuaranteePlanRequest | ReviewerGuaranteeRunRequest, action: 'plan' | 'run' = 'plan'): Promise<ReviewerCommandResult> {
  const full = commandArgsForGuarantees(action, request, workspaceRoot);
  const [command, ...args] = full;
  if (!fileExists(args[0] ?? '')) return Promise.resolve({
    ok: false, exitCode: null, command: full, stdout: '',
    stderr: 'Platform guarantee runner is unavailable. Configure TREESEED_PLATFORM_WORKSPACE or open Reviewer from the Platform workspace.',
  });
  return new Promise((resolvePromise) => {
    const child = spawn(resolveCommand(workspaceRoot, command!), args, { cwd: workspaceRoot, env: process.env, shell: false });
    const stdout: string[] = [];
    const stderr: string[] = [];
    child.stdout.on('data', (chunk) => stdout.push(String(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(String(chunk)));
    child.on('close', (code) => {
      const out = stdout.join('');
      const err = stderr.join('');
      resolvePromise({
        ok: code === 0,
        exitCode: code,
        command: full,
        stdout: out,
        stderr: err,
        report: parseJsonReport(out),
      });
    });
  });
}

export function startGuaranteeRunTask(input: { workspaceRoot: string; request: ReviewerGuaranteeRunRequest; tasks: Map<string, ReviewerTask> }) {
  const id = `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const command = commandArgsForGuarantees('run', input.request, input.workspaceRoot);
  const beforeRunIds = new Set(discoverGuaranteeRuns(input.workspaceRoot).map((run) => run.runId));
  const task: ReviewerTask = { id, status: 'running', command, startedAt: timestamp(), stdout: [], stderr: [], output: [], lastOutputAt: timestamp() };
  input.tasks.set(id, task);
  const [cmd, ...args] = command;
  if (!fileExists(args[0] ?? '')) {
    task.status = 'failed';
    task.completedAt = timestamp();
    task.stderr.push('Platform guarantee runner is unavailable. Configure TREESEED_PLATFORM_WORKSPACE or open Reviewer from the Platform workspace.\n');
    task.result = { ok: false, exitCode: null, command, stdout: '', stderr: task.stderr.join('') };
    appendTaskLine(task, 'Platform guarantee runner is unavailable; no fallback or fabricated evidence was used.');
    return task;
  }
  const executable = resolveCommand(input.workspaceRoot, cmd!);
  appendTaskLine(task, `starting guarantee run task ${id}`);
  appendTaskLine(task, `workspace: ${input.workspaceRoot}`);
  appendTaskLine(task, `command: ${command.join(' ')}`);
  appendTaskLine(task, executable === cmd ? 'using trsd from PATH' : `using managed workspace binary: ${executable}`);
  const child = spawn(executable, args, { cwd: input.workspaceRoot, env: process.env, shell: false });
  appendTaskLine(task, `spawned process pid ${child.pid ?? 'unknown'}`);
  let heartbeatCount = 0;
  const heartbeat = setInterval(() => {
    heartbeatCount += 1;
    appendTaskLine(task, `guarantee command still running (${heartbeatCount * 5}s elapsed); waiting for CLI output or completion`);
  }, 5_000);
  child.stdout.on('data', (chunk) => {
    const text = String(chunk);
    task.stdout.push(text);
    appendTaskOutput(task, text);
  });
  child.stderr.on('data', (chunk) => {
    const text = String(chunk);
    task.stderr.push(text);
    appendTaskOutput(task, text);
  });
  child.on('error', (error) => {
    clearInterval(heartbeat);
    task.status = 'failed';
    task.completedAt = timestamp();
    task.stderr.push(`${error.message}\n`);
    appendTaskLine(task, `failed to start command: ${error.message}`);
    task.result = {
      ok: false,
      exitCode: null,
      command,
      stdout: task.stdout.join(''),
      stderr: task.stderr.join(''),
    };
  });
  child.on('close', (code) => {
    clearInterval(heartbeat);
    const stdout = task.stdout.join('');
    const result: ReviewerCommandResult = {
      ok: code === 0,
      exitCode: code,
      command,
      stdout,
      stderr: task.stderr.join(''),
      report: parseJsonReport(stdout),
    };
    task.status = code === 0 ? 'completed' : 'failed';
    task.completedAt = timestamp();
    task.result = result;
    const runs = discoverGuaranteeRuns(input.workspaceRoot);
    task.run = runs.find((run) => !beforeRunIds.has(run.runId)) ?? runs.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0];
    appendTaskLine(task, `guarantee command exited with code ${code ?? 'unknown'}`);
    if (task.run) appendTaskLine(task, `latest guarantee run detected: ${task.run.outputRoot}`);
    else appendTaskLine(task, 'no guarantee run report was discovered after command exit');
  });
  return task;
}

export function runStat(path: string) {
  return existsSync(path) ? statSync(path) : null;
}
