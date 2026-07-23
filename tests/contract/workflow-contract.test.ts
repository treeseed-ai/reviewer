import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('reviewer verification workflow', () => {
  it('supports exact registry and exact Git SDK dependency transports', () => {
    const workflow = readFileSync('.github/workflows/verify.yml', 'utf8');

    expect(workflow).toContain('[[ ! "${TREESEED_SDK_REF}" =~ ^[0-9a-f]{40}$ ]]');
    expect(workflow).toContain("require('./node_modules/@treeseed/sdk/package.json').version");
    expect(workflow).toContain('gh run download "${run_id}" --repo treeseed-ai/sdk');
  });
});
