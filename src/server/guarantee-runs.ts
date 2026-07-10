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
import type { TreeseedGuaranteePlanReport, TreeseedGuaranteeRunReport } from '@treeseed/sdk/guarantees';
import { discoverTreeseedGuarantees } from '@treeseed/sdk/guarantees';
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

function summaryFromReport(paths: ReviewerRunPaths, report: TreeseedGuaranteeRunReport): ReviewerGuaranteeRunSummary {
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
        out.push(summaryFromReport(paths, readJson<TreeseedGuaranteeRunReport>(paths.reportPath)));
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
  const registry = discoverTreeseedGuarantees({ workspaceRoot });
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
  const report = readJson<TreeseedGuaranteeRunReport>(paths.reportPath);
  const plan = fileExists(paths.planPath) ? readJson<TreeseedGuaranteePlanReport>(paths.planPath) : null;
  const run = summaryFromReport(paths, report);
  return {
    run,
    report,
    plan,
    items: buildReviewItems({ workspaceRoot, run, report, plan }),
  };
}

export function commandArgsForGuarantees(action: 'plan' | 'run', request: ReviewerGuaranteePlanRequest | ReviewerGuaranteeRunRequest) {
  const args = ['trsd', 'guarantees', action, '--environment', request.environment, '--json'];
  const filter = request.filter ?? {};
  if (filter.ownerPackage) args.push('--owner-package', filter.ownerPackage);
  if (filter.type) args.push('--type', filter.type);
  if (filter.subtype) args.push('--subtype', filter.subtype);
  if (filter.gate) args.push('--gate', String(filter.gate));
  if (filter.status) args.push('--status', String(filter.status));
  for (const id of filter.ids ?? []) args.push('--id', id);
  for (const index of filter.journeyIndexes ?? []) args.push('--journey-index', String(index));
  if (request.includeDependencies === false) args.push('--no-dependencies');
  if (request.includePlanned) args.push('--include-planned');
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
  if (command !== 'trsd') return command;
  const local = resolve(workspaceRoot, 'node_modules', '.bin', 'trsd');
  return existsSync(local) ? local : command;
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
  const full = commandArgsForGuarantees(action, request);
  const [command, ...args] = full;
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
  const command = commandArgsForGuarantees('run', input.request);
  const beforeRunIds = new Set(discoverGuaranteeRuns(input.workspaceRoot).map((run) => run.runId));
  const task: ReviewerTask = { id, status: 'running', command, startedAt: timestamp(), stdout: [], stderr: [], output: [], lastOutputAt: timestamp() };
  input.tasks.set(id, task);
  const [cmd, ...args] = command;
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
