import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { basename, extname, join, resolve } from 'node:path';
import type { ReviewerDraftNote, ReviewerGuaranteeRunRequest } from '../shared/contracts.ts';
import { serveEvidence, serveEvidenceText } from './evidence.ts';
import { discoverGuaranteeCatalog, discoverGuaranteeRuns, loadGuaranteeReviewRun, runGuaranteeCommand, startGuaranteeRunTask } from './guarantee-runs.ts';
import { createWorkplan, readDraft, writeDraft } from './workplans.ts';
import type { ReviewerServerContext } from './workspace.ts';
import { assertInsideWorkspace, fileExists } from './workspace.ts';

function sendJson(response: ServerResponse, status: number, payload: unknown) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(payload, null, 2));
}

function sendError(response: ServerResponse, status: number, error: unknown) {
  sendJson(response, status, { error: String(error) });
}

async function readBody<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) as T : {} as T;
}

function notFound(response: ServerResponse) {
  sendJson(response, 404, { error: 'Not found.' });
}

function contentType(path: string) {
  const ext = extname(path).toLowerCase();
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.js') return 'text/javascript; charset=utf-8';
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.svg') return 'image/svg+xml';
  if (ext === '.png') return 'image/png';
  if (ext === '.json') return 'application/json; charset=utf-8';
  return 'application/octet-stream';
}

function serveStatic(context: ReviewerServerContext, url: URL, response: ServerResponse) {
  const pathname = decodeURIComponent(url.pathname);
  const candidate = pathname === '/' || !extname(pathname)
    ? resolve(context.uiRoot, 'index.html')
    : resolve(context.uiRoot, pathname.replace(/^\/+/u, ''));
  const target = assertInsideWorkspace(context.uiRoot, candidate);
  if (!fileExists(target)) {
    const index = resolve(context.uiRoot, 'index.html');
    if (!fileExists(index)) {
      sendJson(response, 503, { error: 'Reviewer UI has not been built. Run `npm -w packages/reviewer run build`.' });
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(readFileSync(index));
    return;
  }
  response.writeHead(200, { 'content-type': contentType(target), 'cache-control': 'no-store' });
  response.end(readFileSync(target));
}

export async function handleReviewerRequest(context: ReviewerServerContext, request: IncomingMessage, response: ServerResponse) {
  const url = new URL(request.url!, 'http://127.0.0.1');
  try {
    if (url.pathname === '/api/workspace' && request.method === 'GET') {
      sendJson(response, 200, { workspaceRoot: context.workspaceRoot, reviewerVersion: context.version, packageName: '@treeseed/reviewer' });
      return;
    }
    if (url.pathname === '/api/guarantee-runs' && request.method === 'GET') {
      sendJson(response, 200, { runs: discoverGuaranteeRuns(context.workspaceRoot) });
      return;
    }
    if (url.pathname === '/api/guarantee-catalog' && request.method === 'GET') {
      sendJson(response, 200, { guarantees: discoverGuaranteeCatalog(context.workspaceRoot) });
      return;
    }
    if (url.pathname === '/api/guarantee-runs/plan' && request.method === 'POST') {
      const body = await readBody<Parameters<typeof runGuaranteeCommand>[1]>(request);
      const result = await runGuaranteeCommand(context.workspaceRoot, body);
      sendJson(response, result.ok ? 200 : 500, result);
      return;
    }
    if (url.pathname === '/api/guarantee-runs/run' && request.method === 'POST') {
      const body = await readBody<ReviewerGuaranteeRunRequest>(request);
      const task = startGuaranteeRunTask({ workspaceRoot: context.workspaceRoot, request: body, tasks: context.tasks });
      sendJson(response, 202, { task });
      return;
    }
    const runMatch = url.pathname.match(/^\/api\/guarantee-runs\/([^/]+)$/u);
    if (runMatch && request.method === 'GET') {
      sendJson(response, 200, loadGuaranteeReviewRun(context.workspaceRoot, decodeURIComponent(runMatch[1]!)));
      return;
    }
    const taskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/u);
    if (taskMatch && request.method === 'GET') {
      const task = context.tasks.get(decodeURIComponent(taskMatch[1]!));
      if (!task) return notFound(response);
      sendJson(response, 200, { task });
      return;
    }
    const taskEventsMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/events$/u);
    if (taskEventsMatch && request.method === 'GET') {
      const task = context.tasks.get(decodeURIComponent(taskEventsMatch[1]!));
      if (!task) return notFound(response);
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      response.write(`data: ${JSON.stringify({ task })}\n\n`);
      const timer = setInterval(() => {
        response.write(`data: ${JSON.stringify({ task })}\n\n`);
        if (task.status !== 'running') {
          clearInterval(timer);
          response.end();
        }
      }, 500);
      request.on('close', () => clearInterval(timer));
      return;
    }
    if (url.pathname === '/api/evidence' && request.method === 'GET') {
      serveEvidence(context.workspaceRoot, url, request, response);
      return;
    }
    if (url.pathname === '/api/evidence/text' && request.method === 'GET') {
      serveEvidenceText(context.workspaceRoot, url, response);
      return;
    }
    const noteMatch = url.pathname.match(/^\/api\/review-notes\/([^/]+)\/(.+)$/u);
    if (noteMatch && request.method === 'GET') {
      const runId = decodeURIComponent(noteMatch[1]!);
      const guaranteeId = decodeURIComponent(noteMatch[2]!);
      sendJson(response, 200, { draft: readDraft(context.workspaceRoot, runId, guaranteeId) });
      return;
    }
    if (noteMatch && request.method === 'PUT') {
      const runId = decodeURIComponent(noteMatch[1]!);
      const guaranteeId = decodeURIComponent(noteMatch[2]!);
      const body = await readBody<ReviewerDraftNote>(request);
      const path = writeDraft(context.workspaceRoot, { ...body, runId, guaranteeId, schemaVersion: 'treeseed.reviewer.draft-note/v1' });
      sendJson(response, 200, { path, draft: readDraft(context.workspaceRoot, runId, guaranteeId) });
      return;
    }
    if (url.pathname === '/api/workplans' && request.method === 'POST') {
      const body = await readBody<Parameters<typeof createWorkplan>[1]>(request);
      sendJson(response, 200, createWorkplan(context.workspaceRoot, body));
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      notFound(response);
      return;
    }
    serveStatic(context, url, response);
  } catch (error) {
    sendError(response, 500, error);
  }
}
