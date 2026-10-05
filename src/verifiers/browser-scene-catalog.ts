import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parse } from 'yaml';
import type { SceneCase, SceneDocument } from './browser-scene-types.ts';

type GuaranteeEntry = { sourcePath: string; manifest: Record<string, any> };

function packageRoot() {
  return resolve(import.meta.dirname, '../..');
}

export function resolveAdminPackageRoot(explicit?: string) {
  const root = explicit?.trim() || resolve(dirname(packageRoot()), 'admin');
  const catalog = resolve(root, 'dist/standards/guarantee-catalog.json');
  if (!existsSync(catalog)) throw new Error(`Exact Admin guarantee catalog is missing at ${catalog}.`);
  return root;
}

function topological(entries: GuaranteeEntry[]) {
  const byId = new Map(entries.map((entry) => [String(entry.manifest.id), entry]));
  const visited = new Set<string>(), visiting = new Set<string>(), result: GuaranteeEntry[] = [];
  const visit = (entry: GuaranteeEntry) => {
    const id = String(entry.manifest.id);
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error(`Guarantee dependency cycle includes ${id}.`);
    visiting.add(id);
    for (const dependency of entry.manifest.dependencies?.guarantees ?? []) {
      const found = byId.get(String(dependency));
      if (found) visit(found);
    }
    visiting.delete(id); visited.add(id); result.push(entry);
  };
  for (const entry of entries) visit(entry);
  return result;
}

function requiredScene(entry: GuaranteeEntry, adminRoot: string): SceneCase | null {
  const declaration = entry.manifest.scene;
  if (declaration?.required !== true || !declaration.executionKey || !declaration.manifest) return null;
  const guaranteeRoot = dirname(resolve(adminRoot, entry.sourcePath));
  const scenePath = resolve(guaranteeRoot, String(declaration.manifest));
  if (!scenePath.startsWith(`${adminRoot}/`) || !existsSync(scenePath)) {
    throw new Error(`${entry.manifest.id} references missing or unsafe scene ${declaration.manifest}.`);
  }
  const scene = parse(readFileSync(scenePath, 'utf8')) as SceneDocument;
  if (scene?.id === undefined || !Array.isArray(scene.workflow)) throw new Error(`Invalid scene manifest ${scenePath}.`);
  return { executionKey: String(declaration.executionKey), scenePath, scene, guaranteeIds: [String(entry.manifest.id)], dependsOn: [] };
}

export function loadActiveIdentityTeamScenes(adminRoot: string) {
  const catalog = JSON.parse(readFileSync(resolve(adminRoot, 'dist/standards/guarantee-catalog.json'), 'utf8')) as { guarantees?: GuaranteeEntry[] };
  const entries = (catalog.guarantees ?? []).filter((entry) => entry.manifest.status === 'active' && ['user', 'team'].includes(String(entry.manifest.type)));
  const grouped = new Map<string, SceneCase>();
  const executionKeyByGuarantee = new Map<string, string>();
  for (const entry of topological(entries)) {
    const sceneCase = requiredScene(entry, adminRoot);
    if (!sceneCase) continue;
    const prior = grouped.get(sceneCase.executionKey);
    const dependencies = (entry.manifest.dependencies?.guarantees ?? [])
      .map((id: unknown) => executionKeyByGuarantee.get(String(id)))
      .filter((key: string | undefined): key is string => Boolean(key && key !== sceneCase.executionKey));
    if (prior) {
      prior.guaranteeIds.push(...sceneCase.guaranteeIds);
      prior.dependsOn.push(...dependencies);
    } else {
      sceneCase.dependsOn.push(...dependencies);
      grouped.set(sceneCase.executionKey, sceneCase);
    }
    executionKeyByGuarantee.set(String(entry.manifest.id), sceneCase.executionKey);
  }
  for (const sceneCase of grouped.values()) sceneCase.dependsOn = [...new Set(sceneCase.dependsOn)];
  return grouped;
}
