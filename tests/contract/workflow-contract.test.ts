import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('reviewer verification workflow', () => {
  it('verifies released dependencies and preserves the packed artifact', () => {
    const workflow = readFileSync('.github/workflows/verify.yml', 'utf8');

    expect(workflow).toContain("import('@treeseed/sdk/operator-contracts')");
    expect(workflow).toContain("require('./node_modules/@treeseed/ui/package.json').version");
    expect(workflow).toContain('npm pack --json --ignore-scripts --pack-destination artifacts');
    expect(workflow).toContain('name: reviewer-${{ github.sha }}');
    expect(workflow).not.toContain('TREESEED_SDK_REF');
    expect(workflow).not.toContain('gh run download');
  });
});
