import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

describe('reviewer verification workflow', () => {
  it('runs one immutable owner scene implementation and retains failure evidence', () => {
    const action = parse(readFileSync('.github/actions/run-scenes/action.yml', 'utf8'));
    const steps = action.runs.steps as Array<Record<string, any>>;
    const checkout = steps.find(step => step.uses === 'actions/checkout@v4')!;
    expect(checkout.with).toEqual({ repository: 'treeseed-ai/reviewer', ref: '${{ github.action_ref }}',
      path: '.treeseed/tools/reviewer', 'persist-credentials': false, 'fetch-depth': 1 });
    expect(steps[0]!.env.REVIEWER_REF).toBe('${{ github.action_ref }}');
    expect(steps[0]!.run).toContain('test ! -e .treeseed/tools/reviewer');
    expect(steps[0]!.run).toContain('^[0-9a-f]{40}$');
    const execution = steps.find(step => step.name === 'Execute owner scenes')!;
    expect(steps.indexOf(checkout)).toBeGreaterThan(0); expect(steps.indexOf(checkout)).toBeLessThan(steps.indexOf(execution));
    const dependencies = steps.find(step => step.name === 'Install the executing Reviewer suite dependencies')!;
    expect(dependencies.run).toBe('npm ci --prefix .treeseed/tools/reviewer --ignore-scripts --no-audit --no-fund');
    expect(steps.indexOf(dependencies)).toBeLessThan(steps.indexOf(execution));
    expect(steps.find(step => step.uses === 'erlef/setup-beam@v1')!.with).toEqual({ 'otp-version': '27.3.4.18', 'elixir-version': '1.17.3' });
    expect(execution.run).toContain('--import ./.treeseed/tools/reviewer/node_modules/tsx/dist/loader.mjs');
    expect(JSON.stringify(steps)).not.toContain('cp -a');
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
