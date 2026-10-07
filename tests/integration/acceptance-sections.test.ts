import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import type { GuaranteeRunReport } from '@treeseed/sdk/guarantees';
import { specificationFixture } from '../fixtures/guarantee-specification.ts';

it('packaged native exact-heading selection enforces shared parent obligations before staged execution while retaining future children', () => {
  const fixture = specificationFixture();
  try {
    const specification = '# Specification\n## Projects\n- Source bytes remain exact.\n### First\n- Native readback matches source bytes.\n### Later\n- Future release remains required.\n';
    const sections = ['Specification / Projects / First'], exact = ['Specification / Projects'];
    const identities = ['- Source bytes remain exact.', '- Native readback matches source bytes.', '- Future release remains required.']
      .map((text, index) => createHash('sha256').update(`${index === 0 ? exact[0] : index === 1 ? sections[0] : 'Specification / Projects / Later'}\n${text}`).digest('hex'));
    fixture.files.set('acceptance.md', Buffer.from(specification)); fixture.restore();
    for (const [index, contract] of fixture.contracts.entries()) {
      const path = `guarantees/${contract.id}.guarantee.yaml`, manifest = JSON.parse(fixture.files.get(path)!.toString());
      manifest.acceptanceCriteria = [{ criterion: identities[index], verifierRefs: [contract.ref] }];
      fixture.files.set(path, Buffer.from(JSON.stringify(manifest))); fixture.restore();
    }
    const planned = fixture.invoke('exact-heading-plan', undefined, true, sections, exact);
    expect(planned.child.status).toBe(0);
    expect(planned.report.acceptanceSelection).toEqual({ sections, exactSections: exact, wholeTotal: 3, selectedIds: identities.slice(0, 2), deferredIds: identities.slice(2), wholeSpecification: false });
    const failures = new Map<string, Buffer>();
    for (const [index, changed] of [specification.replace('bytes remain exact', 'bytes may change'), specification.replace('### First', '- Another shared obligation.\n### First')].entries()) {
      writeFileSync(resolve(fixture.root, 'acceptance.md'), changed);
      const denied = fixture.invoke(`exact-heading-denied-${index}`, undefined, false, sections, exact), report = denied.report as GuaranteeRunReport;
      expect(denied.child.status).toBe(1); expect(report.counts.passed).toBe(0); expect(report.results.every(result => result.status === 'blocked')).toBe(true);
      expect(existsSync(resolve(fixture.root, '.treeseed/observations'))).toBe(false);
      expect(readFileSync(resolve(fixture.root, 'acceptance.md'), 'utf8')).toBe(changed);
      const path = resolve(fixture.root, '.treeseed/guarantees/runs', `exact-heading-denied-${index}`, 'report.json');
      failures.set(path, readFileSync(path)); expect(JSON.parse(failures.get(path)!.toString())).toEqual(report);
    }
    fixture.restore();
    const passed = fixture.invoke('exact-heading-fresh', undefined, false, sections, exact), report = passed.report as GuaranteeRunReport;
    expect(passed.child.status).toBe(0); expect(report.counts.passed).toBe(2); expect(report.acceptanceSelection).toEqual(planned.report.acceptanceSelection);
    const output = resolve(fixture.root, '.treeseed/guarantees/runs/exact-heading-fresh');
    const prerequisite = report.results[0]!.evidence!.find(path => path.includes('prerequisite-'))!;
    expect(JSON.parse(readFileSync(resolve(output, prerequisite), 'utf8'))).toMatchObject({ passed: true, exitCode: 0, checks: { total: 2, passed: 2, failed: 0, skipped: 0, todo: 0 } });
    const observations = readFileSync(resolve(fixture.root, '.treeseed/observations'));
    expect(observations.toString().trim().split('\n').sort()).toEqual(['native', 'native', 'unit', 'unit']);
    expect(fixture.invoke('exact-heading-whole').child.status).toBe(1);
    expect(readFileSync(resolve(fixture.root, '.treeseed/observations'))).toEqual(observations);
    expect(JSON.parse(readFileSync(resolve(output, 'report.json'), 'utf8'))).toEqual(report);
    for (const [path, bytes] of failures) expect(readFileSync(path)).toEqual(bytes);
    for (const [path, bytes] of fixture.files) expect(readFileSync(resolve(fixture.root, path))).toEqual(bytes);
  } finally { fixture.close(); }
});

it('packaged native section acceptance retains deferred obligations and full-suite evidence while whole acceptance remains blocked', () => {
  const fixture = specificationFixture();
  try {
    const sections = ['Specification / Shared', 'Specification / First project'];
    const specification = '# Specification\n## Shared\n- Source bytes remain exact.\n## First project\n- Native readback matches source bytes.\n## Later project\n- Later native publication is required.\n';
    const identity = (section: string, text: string) => createHash('sha256').update(`Specification / ${section}\n${text}`).digest('hex');
    const selectedIds = [identity('Shared', '- Source bytes remain exact.'), identity('First project', '- Native readback matches source bytes.')];
    const deferredIds = [identity('Later project', '- Later native publication is required.')];
    const put = (path: string, bytes: string) => { fixture.files.set(path, Buffer.from(bytes)); writeFileSync(resolve(fixture.root, path), bytes); };
    put('acceptance.md', specification);
    for (const [index, contract] of fixture.contracts.entries()) {
      const path = `guarantees/${contract.id}.guarantee.yaml`, manifest = JSON.parse(fixture.files.get(path)!.toString());
      manifest.acceptanceCriteria = [{ criterion: selectedIds[index], verifierRefs: [contract.ref] }];
      put(path, JSON.stringify(manifest));
    }
    const selection = { sections, wholeTotal: 3, selectedIds, deferredIds, wholeSpecification: false };
    const planned = fixture.invoke('stage-plan', undefined, true, sections);
    expect(planned.child.status).toBe(0); expect(planned.report.acceptanceSelection).toEqual(selection);
    expect(existsSync(resolve(fixture.root, '.treeseed/observations'))).toBe(false);
    const failed = new Map<string, Buffer>();
    for (const [index, input] of [
      { sections: [], specification },
      { sections: ['Specification / Missing'], specification },
      { sections: [sections[0]!, sections[0]!], specification },
      { sections, specification: specification.replace('bytes remain exact', 'bytes may change') },
      { sections, specification: specification.replace('## First project', '- Another shared requirement.\n## First project') },
    ].entries()) {
      writeFileSync(resolve(fixture.root, 'acceptance.md'), input.specification);
      const before = [...fixture.files.keys()].map(path => [path, readFileSync(resolve(fixture.root, path))] as const);
      const denied = fixture.invoke(`stage-denied-${index}`, undefined, false, input.sections), report = denied.report as GuaranteeRunReport;
      expect(denied.child.status).toBe(1); expect(report.ok).toBe(false); expect(report.counts.passed).toBe(0);
      expect(report.results.every(result => result.status === 'blocked')).toBe(true);
      expect(report.results.flatMap(result => result.evidence ?? [])).toEqual([]);
      expect(existsSync(resolve(fixture.root, '.treeseed/observations'))).toBe(false);
      const path = resolve(fixture.root, '.treeseed/guarantees/runs', `stage-denied-${index}`, 'report.json');
      failed.set(path, readFileSync(path)); expect(JSON.parse(failed.get(path)!.toString())).toEqual(report);
      for (const [path, bytes] of before) expect(readFileSync(resolve(fixture.root, path))).toEqual(bytes);
    }
    fixture.restore();
    const passed = fixture.invoke('fresh-stage-run', undefined, false, sections), report = passed.report as GuaranteeRunReport;
    expect(passed.child.status).toBe(0); expect(report.acceptanceSelection).toEqual(selection);
    expect(report.results.map(result => [result.id, result.status])).toEqual([['proof.unit', 'passed'], ['proof.native', 'passed']]);
    const output = resolve(fixture.root, '.treeseed/guarantees/runs/fresh-stage-run');
    const prerequisite = report.results[0]!.evidence!.find(path => path.includes('prerequisite-'))!;
    expect(JSON.parse(readFileSync(resolve(output, prerequisite), 'utf8'))).toMatchObject({ passed: true, exitCode: 0, checks: { total: 2, passed: 2, failed: 0, skipped: 0, todo: 0 } });
    for (const contract of fixture.contracts) {
      const result = report.results.find(result => result.id === contract.id)!;
      const path = result.evidence!.find(path => !path.includes('prerequisite-'))!;
      expect(JSON.parse(readFileSync(resolve(output, path), 'utf8'))).toMatchObject({ verifierId: contract.ref, testName: contract.name, passed: true, exitCode: 0, signal: null, sourceDigest: createHash('sha256').update(fixture.files.get(contract.file)!).digest('hex') });
    }
    const observations = readFileSync(resolve(fixture.root, '.treeseed/observations'));
    expect(observations.toString().trim().split('\n').sort()).toEqual(['native', 'native', 'unit', 'unit']);
    const whole = fixture.invoke('whole-still-blocked');
    expect(whole.child.status).toBe(1); expect(whole.report.ok).toBe(false);
    expect(readFileSync(resolve(fixture.root, '.treeseed/observations'))).toEqual(observations);
    expect(JSON.parse(readFileSync(resolve(output, 'report.json'), 'utf8'))).toEqual(report);
    for (const [path, bytes] of failed) expect(readFileSync(path)).toEqual(bytes);
    for (const [path, bytes] of fixture.files) expect(readFileSync(resolve(fixture.root, path))).toEqual(bytes);
  } finally { fixture.close(); }
});
