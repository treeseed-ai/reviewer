import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { sanitizeBrowserTrace } from '../../src/verifiers/browser-trace-redaction.ts';

describe('browser trace redaction', () => {
  it('removes network payloads and textual resources while retaining redacted actions and screenshots', () => {
    const path = resolve(mkdtempSync(resolve(tmpdir(), 'treeseed-trace-')), 'trace.zip');
    writeFileSync(path, zipSync({
      'trace.network': strToU8('authorization: Bearer exposed'),
      'trace.trace': strToU8(JSON.stringify({ type: 'before', params: { password: 'TreeSeedGuaranteeReset123!', url: '/confirm?token=confirm_exposed' } }) + '\n'),
      'resources/body.dat': strToU8('refreshToken=exposed'),
      'resources/screenshot.jpeg': new Uint8Array([1, 2, 3]),
    }));

    sanitizeBrowserTrace(path);

    const archive = unzipSync(new Uint8Array(readFileSync(path)));
    expect(Object.keys(archive).sort()).toEqual(['resources/screenshot.jpeg', 'trace.trace']);
    const trace = strFromU8(archive['trace.trace']!);
    expect(trace).not.toContain('TreeSeedGuarantee');
    expect(trace).not.toContain('confirm_exposed');
    expect(trace).toContain('[REDACTED]');
  });
});
