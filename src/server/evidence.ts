import { createReadStream, readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, resolve } from 'node:path';
import { assertInsideWorkspace, fileExists } from './workspace.ts';

const CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.jsonl': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.markdown': 'text/markdown; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.zip': 'application/zip',
};

export function resolveEvidencePath(workspaceRoot: string, value: string) {
  if (!value.trim()) throw new Error('Missing evidence path.');
  const target = value.startsWith('/') ? value : resolve(workspaceRoot, value);
  return assertInsideWorkspace(workspaceRoot, target);
}

export function contentTypeFor(path: string) {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

export function serveEvidence(workspaceRoot: string, url: URL, _request: IncomingMessage, response: ServerResponse) {
  const target = resolveEvidencePath(workspaceRoot, url.searchParams.get('path') ?? '');
  if (!fileExists(target)) {
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'Evidence file not found.' }));
    return;
  }
  response.writeHead(200, { 'content-type': contentTypeFor(target), 'cache-control': 'no-store' });
  createReadStream(target).pipe(response);
}

export function serveEvidenceText(workspaceRoot: string, url: URL, response: ServerResponse) {
  const target = resolveEvidencePath(workspaceRoot, url.searchParams.get('path') ?? '');
  if (!fileExists(target)) {
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'Evidence file not found.' }));
    return;
  }
  const startLine = Math.max(0, Number(url.searchParams.get('startLine') ?? 0) || 0);
  const lineCount = Math.min(2000, Math.max(1, Number(url.searchParams.get('lineCount') ?? 400) || 400));
  const lines = readFileSync(target, 'utf8').split(/\r?\n/u);
  response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify({
    path: target,
    startLine,
    lineCount,
    totalLines: lines.length,
    text: lines.slice(startLine, startLine + lineCount).join('\n'),
  }));
}
