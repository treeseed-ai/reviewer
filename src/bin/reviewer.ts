#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { startReviewerServer } from '../server/app.ts';

function argValue(args: string[], name: string) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function hasArg(args: string[], name: string) {
  return args.includes(name);
}

const args = process.argv.slice(2);
if (hasArg(args, '--help') || hasArg(args, '-h')) {
  console.log([
    'Usage: treeseed-reviewer [--workspace <path>] [--host 127.0.0.1] [--port 4757] [--open] [--run-id <id>]',
    '',
    'Starts the local-only TreeSeed guarantee reviewer web app.',
  ].join('\n'));
  process.exit(0);
}

const workspace = resolve(argValue(args, '--workspace') ?? process.cwd());
const host = argValue(args, '--host') ?? '127.0.0.1';
const port = Number(argValue(args, '--port') ?? 4757);
const runId = argValue(args, '--run-id') ?? argValue(args, '--run-path');
const started = await startReviewerServer({ workspaceRoot: workspace, host, port });
const url = runId ? `${started.url}runs/${encodeURIComponent(runId)}/review` : started.url;
console.log(`TreeSeed reviewer listening on ${url}`);

if (hasArg(args, '--open')) {
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const openerArgs = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  spawn(opener, openerArgs, { stdio: 'ignore', detached: true }).unref();
}

process.on('SIGINT', () => {
  void started.close().finally(() => process.exit(0));
});
