import { createServer } from 'node:http';
import { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { handleReviewerRequest } from './routes.ts';
import { packageRootFromImportMeta, packageVersion, type ReviewerServerContext } from './workspace.ts';

export type ReviewerServerOptions = {
  workspaceRoot?: string;
  host?: string;
  port?: number;
  packageRoot?: string;
};

function listen(server: ReturnType<typeof createServer>, host: string, port: number) {
  return new Promise<{ port: number; host: string }>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      const address = server.address() as AddressInfo;
      resolvePromise({ port: address.port, host });
    });
  });
}

async function listenFirstAvailable(server: ReturnType<typeof createServer>, host: string, requestedPort: number) {
  for (let port = requestedPort; port < requestedPort + 50; port += 1) {
    try {
      return await listen(server, host, port);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EADDRINUSE') throw error;
    }
  }
  throw new Error(`No available reviewer port found starting at ${requestedPort}.`);
}

export async function startReviewerServer(options: ReviewerServerOptions = {}) {
  const packageRoot = options.packageRoot ?? packageRootFromImportMeta();
  const context: ReviewerServerContext = {
    workspaceRoot: resolve(options.workspaceRoot ?? process.cwd()),
    packageRoot,
    uiRoot: resolve(packageRoot, 'dist', 'ui'),
    version: packageVersion(packageRoot),
    tasks: new Map(),
  };
  const host = options.host ?? '127.0.0.1';
  if (host === '0.0.0.0') throw new Error('Reviewer is local-only and will not bind 0.0.0.0 by default.');
  const server = createServer((request, response) => {
    void handleReviewerRequest(context, request, response);
  });
  const address = await listenFirstAvailable(server, host, options.port ?? 4757);
  return {
    server,
    context,
    url: `http://${address.host}:${address.port}/`,
    close: () => new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise())),
  };
}
