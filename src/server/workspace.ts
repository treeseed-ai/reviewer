import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export type ReviewerServerContext = {
  workspaceRoot: string;
  packageRoot: string;
  uiRoot: string;
  version: string;
  tasks: Map<string, import('../shared/contracts.ts').ReviewerTask>;
};

export function packageRootFromImportMeta() {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, '../..'),
    resolve(here, '../../..'),
    process.cwd(),
  ];
  return candidates.find((candidate) => existsSync(resolve(candidate, 'package.json'))) ?? process.cwd();
}

export function packageVersion(packageRoot: string) {
  try {
    const parsed = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8')) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : '0.0.0-dev';
  } catch {
    return '0.0.0-dev';
  }
}

export function assertInsideWorkspace(workspaceRoot: string, path: string) {
  const root = resolve(workspaceRoot);
  const target = resolve(path);
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new Error(`Path is outside workspace: ${path}`);
  }
  return target;
}

export function workspaceRelative(workspaceRoot: string, path: string) {
  return relative(workspaceRoot, path).split(sep).join('/');
}

export function safeSlug(value: string) {
  return value.trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 96) || 'item';
}

export function fileExists(path: string) {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

export function directoryExists(path: string) {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}
