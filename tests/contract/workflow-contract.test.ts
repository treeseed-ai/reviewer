import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

describe('reviewer verification workflow', () => {
  it('runs one immutable owner scene implementation and retains failure evidence', () => {
    const action = parse(readFileSync('.github/actions/run-scenes/action.yml', 'utf8'));
    const steps = action.runs.steps as Array<Record<string, any>>;
    expect(steps.some(step => step.uses === 'actions/checkout@v4')).toBe(false);
    expect(steps[0]!.env.REVIEWER_ACTION_PATH).toBe('${{ github.action_path }}');
    expect(steps[0]!.run).toContain('cp -a "${REVIEWER_ACTION_PATH}/../../.." .treeseed/tools/reviewer');
    expect(steps[0]!.run).toContain('test ! -e .treeseed/tools/reviewer');
    expect(steps[0]!.run).toContain('^[0-9a-f]{40}$');
    const execution = steps.find(step => step.name === 'Execute owner scenes')!;
    expect(execution.run).toContain('src/verifiers/guarantees/command.ts');
    expect(execution.run).toContain('--environment local');
    expect(execution.run).not.toContain('|| true');
    const evidence = steps.find(step => step.uses === 'actions/upload-artifact@v4')!;
    expect(evidence.if).toBe('always()');
    expect(evidence.with['if-no-files-found']).toBe('error');
    expect(evidence.with['retention-days']).toBe(7);
    expect(evidence.with['include-hidden-files']).toBe(true);
  });
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
