import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { contentTypeFor, resolveEvidencePath } from '../../src/server/evidence.ts';
import { writeDraft, readDraft } from '../../src/server/workplans.ts';

describe('route contracts', () => {
  it('rejects evidence paths outside the workspace', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'treeseed-reviewer-routes-'));
    expect(() => resolveEvidencePath(root, '/etc/passwd')).toThrow(/outside workspace/u);
  });

  it('serves expected content type names', () => {
    expect(contentTypeFor('screen.png')).toBe('image/png');
    expect(contentTypeFor('report.md')).toContain('text/markdown');
    expect(contentTypeFor('console.log')).toContain('text/plain');
  });

  it('writes and updates draft notes under local reviewer state', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'treeseed-reviewer-drafts-'));
    mkdirSync(root, { recursive: true });
    const draft = {
      schemaVersion: 'treeseed.reviewer.draft-note/v1' as const,
      runId: 'run-a',
      guaranteeId: 'guarantee.a.b.c.001',
      updatedAt: '2026-07-08T10:00:00.000Z',
      classification: 'ui-defect' as const,
      priority: 'high' as const,
      ownerPackage: '@treeseed/reviewer',
      note: 'First note',
      selectedEvidenceIds: [],
      includeInWorkplan: true,
    };
    writeDraft(root, draft);
    writeDraft(root, { ...draft, note: 'Updated note' });
    expect(readDraft(root, draft.runId, draft.guaranteeId)?.note).toBe('Updated note');
  });
});
