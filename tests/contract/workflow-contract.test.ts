import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import testConfiguration from '../../vitest.config.ts';
import guaranteeConfiguration from '../../vitest.guarantees.config.ts';

describe('reviewer verification workflow', () => {
  it('runs the entire owning suite serially under unchanged assertion deadlines', () => {
    for (const configuration of [testConfiguration, guaranteeConfiguration]) {
      expect(configuration.test?.include).toEqual(['tests/**/*.test.ts']);
      expect(configuration.test?.testTimeout).toBe(30_000);
      expect(configuration.test?.fileParallelism).toBe(false);
    }
  });
  it('runs one immutable owner scene implementation and retains failure evidence', () => {
    const action = parse(readFileSync('.github/actions/run-scenes/action.yml', 'utf8'));
    const steps = action.runs.steps as Array<Record<string, any>>;
    const checkout = steps.find(step => step.uses === 'actions/checkout@v4')!;
    expect(checkout.with).toEqual({ repository: 'treeseed-ai/reviewer', ref: '${{ steps.reviewer-source.outputs.ref }}',
      path: '.treeseed/tools/reviewer', 'persist-credentials': false, 'fetch-depth': 1 });
    expect(steps[0]!.id).toBe('reviewer-source');
    expect(steps[0]!.env.REVIEWER_REF).toBe('${{ github.action_ref }}');
    expect(steps[0]!.run).toContain('"$GITHUB_OUTPUT"');
    expect(steps[0]!.run).toContain('test ! -e .treeseed/tools/reviewer');
    expect(steps[0]!.run).toContain('^[0-9a-f]{40}$');
    const execution = steps.find(step => step.name === 'Execute owner scenes')!;
    expect(steps.indexOf(checkout)).toBeGreaterThan(0); expect(steps.indexOf(checkout)).toBeLessThan(steps.indexOf(execution));
    const dependencies = steps.find(step => step.name === 'Install the executing Reviewer suite dependencies')!;
    expect(dependencies.run).toBe('npm ci --prefix .treeseed/tools/reviewer --ignore-scripts --no-audit --no-fund');
    expect(steps.indexOf(dependencies)).toBeLessThan(steps.indexOf(execution));
    const sdk = steps.find(step => typeof step.uses === 'string' && step.uses.startsWith('treeseed-ai/sdk/.github/actions/install-exact-sdk@'))!;
    expect(sdk?.uses).toMatch(/^treeseed-ai\/sdk\/\.github\/actions\/install-exact-sdk@[a-f0-9]{40}$/u);
    expect(sdk?.with).toEqual({'github-token':'${{ github.token }}',commit:'${{ steps.reviewer-prerequisites.outputs.sdk-commit }}',paths:'.treeseed/tools/reviewer/node_modules/@treeseed/sdk'});
    const preparation=steps.find(step=>step.id==='reviewer-prerequisites')!;
    expect(preparation?.run).toBe('node --import ./.treeseed/tools/reviewer/node_modules/tsx/dist/loader.mjs .treeseed/tools/reviewer/scripts/scene-action-prerequisites.ts');
    expect(steps.indexOf(preparation)).toBeGreaterThan(steps.indexOf(dependencies));
    const toolchain=steps.find(step=>step.uses==='erlef/setup-beam@v1')!;
    expect(toolchain.if).toBe("steps.reviewer-prerequisites.outputs.toolchain-ready != 'true'");
    expect(steps.indexOf(toolchain)).toBeGreaterThan(steps.indexOf(preparation));
    expect(steps.indexOf(sdk)).toBeGreaterThan(steps.indexOf(dependencies));
    const build = steps.find(step => step.name === 'Build the executing Reviewer archive assets')!;
    expect(steps.indexOf(sdk)).toBeLessThan(steps.indexOf(build));
    expect(build?.run).toBe('npm run --prefix .treeseed/tools/reviewer build:dist');
    expect(steps.indexOf(build)).toBeGreaterThan(steps.indexOf(dependencies));
    expect(steps.indexOf(build)).toBeLessThan(steps.indexOf(execution));
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
    const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
    expect(manifest.dependencies['@treeseed/ui']).toBeUndefined();
    expect(manifest.devDependencies['@treeseed/ui']).toBe('>=0.12.18-rc.11 <0.14.0');

    expect(workflow).toContain("import('@treeseed/sdk/operator-contracts')");
    expect(workflow).toContain("require('./node_modules/@treeseed/ui/package.json').version");
    expect(workflow).toContain('npm pack --json --ignore-scripts --pack-destination artifacts');
    expect(workflow).toContain('name: reviewer-${{ github.sha }}');
    expect(workflow).not.toContain('TREESEED_SDK_REF');
    expect(workflow).not.toContain('gh run download');
  });
});
