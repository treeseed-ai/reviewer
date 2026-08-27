import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { releaseEvidenceSchema } from '@treeseed/sdk/development';

const root = resolve(import.meta.dirname, '..'), hash = (path: string) => `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}` as const;
const action = process.argv[2], evidencePath = resolve(root, process.argv[3] ?? 'artifacts/release-evidence-v1.json');
if (action === 'seal') {
  const archive = resolve(root, process.argv[4]!), sbom = resolve(root, 'artifacts/sbom.cdx.json');
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { name: string; version: string };
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), archiveDigest = hash(archive), sbomDigest = hash(sbom);
  const receiptDigest = `sha256:${createHash('sha256').update(`${commit}\n${archiveDigest}\n${sbomDigest}`).digest('hex')}` as const;
  const evidence = releaseEvidenceSchema.parse({ schemaVersion: 'treeseed.release-evidence/v1', candidate: { id: `candidate-${commit.slice(0, 12)}`, receiptDigest, sourceCommit: commit, stagingRef: process.env.GITHUB_REF ?? 'refs/heads/staging', workflowRunId: process.env.GITHUB_RUN_ID ?? '1', createdAt: new Date().toISOString() }, packages: [{ projectId: 'reviewer', name: pkg.name, version: pkg.version, minimumBump: 'patch' }], artifacts: [
    { id: 'reviewer-archive', kind: 'archive', identity: basename(archive), digest: archiveDigest, mediaType: 'application/gzip', size: statSync(archive).size },
    { id: 'reviewer-sbom', kind: 'sbom', identity: basename(sbom), digest: sbomDigest, mediaType: 'application/vnd.cyclonedx+json', size: statSync(sbom).size },
  ], contractBundles: [], compatibilityAttestations: [], verification: { status: 'passed', operations: ['npm run verify'], completedAt: new Date().toISOString() } });
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
} else if (action === 'verify') {
  const evidence = releaseEvidenceSchema.parse(JSON.parse(readFileSync(evidencePath, 'utf8'))), commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  if (evidence.candidate.sourceCommit !== commit) throw new Error('Reviewer custody source commit mismatch.');
  if (process.env.GITHUB_REF?.startsWith('refs/tags/') && process.env.GITHUB_REF_NAME !== evidence.packages[0]?.version) throw new Error('Reviewer tag does not match sealed version.');
  for (const artifact of evidence.artifacts) if (hash(resolve(evidencePath, '..', artifact.identity)) !== artifact.digest) throw new Error(`Reviewer artifact digest mismatch: ${artifact.identity}.`);
} else throw new Error('release-custody requires seal or verify.');
