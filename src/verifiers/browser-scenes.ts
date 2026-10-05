#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { loadActiveIdentityTeamScenes, resolveAdminPackageRoot } from './browser-scene-catalog.ts';
import { browserDeviceProfileMatrix, executeBrowserScenes } from './browser-scene-executor.ts';

function option(name: string, fallback = '') {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

const startedAt = new Date().toISOString();
const runId = option('run-id', `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`);
const adminOrigin = option('admin-origin', process.env.TREESEED_ADMIN_BASE_URL ?? 'https://admin.treeseed.localhost');
const apiOrigin = option('api-origin', process.env.TREESEED_API_BASE_URL ?? 'https://api.treeseed.localhost');
const mailpitOrigin = option('mailpit-origin', process.env.TREESEED_MAILPIT_BASE_URL ?? 'http://127.0.0.1:8025');
const evidenceRoot = resolve(option('evidence-root', `.treeseed/guarantees/browser-scenes/${runId}`));
const legacyProfile = option('device-profile');
const deviceProfiles = browserDeviceProfileMatrix(option('device-profiles', legacyProfile));

let checks: Awaited<ReturnType<typeof executeBrowserScenes>> = [];
try {
  const adminRoot = resolveAdminPackageRoot(option('admin-package-root'));
  for (const deviceProfile of deviceProfiles) {
    const deviceRunId = `${runId}-${deviceProfile.replaceAll('_', '-')}`;
    const profileChecks = await executeBrowserScenes({ scenes: loadActiveIdentityTeamScenes(adminRoot), adminOrigin, apiOrigin, mailpitOrigin, evidenceRoot: resolve(evidenceRoot, deviceProfile), runId: deviceRunId, deviceProfile, executablePath: option('browser-executable') });
    checks.push(...profileChecks.map((check) => ({ ...check, id: `${deviceProfile}:${check.id}` })));
  }
} catch (error) {
  checks = [{ id: 'admin.browser-scenes.setup', status: 'failed', durationMs: 0, error: error instanceof Error ? error.message : String(error) }];
}
const report = {
  schemaVersion: 'treeseed.guarantee-verifier-result/v1',
  verifierId: '@treeseed/reviewer/admin-browser-scenes',
  startedAt,
  completedAt: new Date().toISOString(),
  environment: { adminOrigin, apiOrigin, mailpitOrigin, deviceProfiles },
  ok: checks.every((entry) => entry.status === 'passed'),
  checks,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.ok) process.exitCode = 1;
