import { readFileSync, writeFileSync } from 'node:fs';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

const visualResource = /\.(?:jpe?g|png|webp)$/iu;
const sensitiveKey = /password|token|secret|cookie|authorization|headers?/iu;

function redactString(value: string) {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/giu, 'Bearer [REDACTED]')
    .replace(/((?:confirm|reset|tiv)_[A-Za-z0-9_-]+)/gu, '[REDACTED]')
    .replace(/([?&](?:token|code|state|code_challenge)=)[^&#\s]+/giu, '$1[REDACTED]')
    .replace(/TreeSeedGuarantee[^\s"']+/gu, '[REDACTED]')
    .replace(/incorrect-password/gu, '[REDACTED]');
}

function scrub(value: unknown, key = ''): unknown {
  if (sensitiveKey.test(key)) return '[REDACTED]';
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map((entry) => scrub(entry));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, scrub(entry, name)]));
  return value;
}

function sanitizeTraceLog(content: Uint8Array) {
  return strToU8(strFromU8(content).split(/\r?\n/u).filter(Boolean).map((line) => {
    try { return JSON.stringify(scrub(JSON.parse(line))); }
    catch { return redactString(line); }
  }).join('\n') + '\n');
}

export function sanitizeBrowserTrace(path: string) {
  const archive = unzipSync(new Uint8Array(readFileSync(path)));
  const sanitized: Record<string, Uint8Array> = {};
  for (const [name, content] of Object.entries(archive)) {
    if (name === 'trace.network') continue;
    if (name.startsWith('resources/') && !visualResource.test(name)) continue;
    sanitized[name] = name === 'trace.trace' ? sanitizeTraceLog(content) : content;
  }
  writeFileSync(path, zipSync(sanitized, { level: 6 }));
}
