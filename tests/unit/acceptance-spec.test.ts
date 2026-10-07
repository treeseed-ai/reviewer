import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { acceptanceCriteria, acceptanceCoverage } from '../../src/verifiers/guarantees/acceptance-spec.ts';
import { localRequestDiagnostics } from '../../src/verifiers/guarantees/command.ts';

const document = '# Acceptance\n\n## Purpose\nOverview.\n\n## Rules\n- Never mutate upstream.\n- [ ] Complete both cycles.\n\nRequired acceptance: exact refs resolve.\n\n## Progress record\nTransient diary.\n\n## Completion\nAll projects pass.\n';
describe('authoritative acceptance specification coverage', () => {
    it('selects shared parent requirements without certifying deferred child projects or dropping new parent obligations', () => {
        const source = '# Spec\n## Projects\nShared project authority.\n### First\n- First outcome.\n### Later\n- Later outcome.\n';
        const criteria = acceptanceCriteria(source), sections = ['Spec / Projects / First'], exact = ['Spec / Projects'];
        const bindings = criteria.map((item, index) => ({ criterion: item.id, verifierRefs: [`proof.${index}`] }));
        const selected = new Set(['proof.0', 'proof.1']), before = structuredClone({ source, criteria, sections, exact, bindings });
        const scoped = acceptanceCoverage(criteria, bindings, selected, sections, exact);
        expect(scoped).toEqual({ ok: true, total: 2, covered: 2, missing: [], diagnostics: [], selection: {
            sections, exactSections: exact, wholeTotal: 3, selectedIds: criteria.slice(0, 2).map(item => item.id), deferredIds: [criteria[2]!.id], wholeSpecification: false,
        } });
        for (const changed of [source.replace('Shared project authority.', 'Changed authority.'), source.replace('### First', 'New shared obligation.\n\n### First')])
            expect(acceptanceCoverage(acceptanceCriteria(changed), bindings, selected, sections, exact).ok).toBe(false);
        for (const paths of [[], [''], [' Spec / Projects'], ['Spec / Missing'], ['Spec / Projects', 'Spec / Projects']])
            expect(() => acceptanceCoverage(criteria, bindings, selected, sections, paths)).toThrow('Acceptance section');
        expect(acceptanceCoverage(criteria, bindings, selected, ['Spec / Projects']).ok).toBe(false);
        expect(acceptanceCoverage(criteria, bindings, selected).ok).toBe(false);
        expect(localRequestDiagnostics(['--acceptance-exact-section', exact[0]!])).toHaveLength(1);
        expect(localRequestDiagnostics(['--acceptance-spec', 'spec.md', '--acceptance-exact-section', exact[0]!])).toEqual([]);
        expect({ source, criteria, sections, exact, bindings }).toEqual(before);
    });
	it('selects exact authoritative sections while retaining full specification identity and excluded obligations', () => {
		const source = '# Spec\n## Shared\n- Shared requirement.\n## First project\n- First outcome.\n### Nested\n- Exact nested outcome.\n## First project extra\n- Separate future outcome.\n## Later project\n- Later outcome.\n';
		const criteria = acceptanceCriteria(source);
		const bindings = criteria.map((criterion, index) => ({ criterion: criterion.id, verifierRefs: [`proof.${index}`] }));
		const sections = ['Spec / Shared', 'Spec / First project'];
		const selected = new Set(['proof.0', 'proof.1', 'proof.2']);
		const before = structuredClone({ source, criteria, bindings, sections, selected: [...selected] });
		const coverage = acceptanceCoverage(criteria, bindings, selected, sections);
		expect(coverage).toEqual({ ok: true, total: 3, covered: 3, missing: [], diagnostics: [], selection: {
			sections, wholeTotal: 5, selectedIds: criteria.slice(0, 3).map(item => item.id), deferredIds: criteria.slice(3).map(item => item.id), wholeSpecification: false,
		} });
		expect(acceptanceCoverage(criteria, bindings, selected).ok).toBe(false);
		expect(acceptanceCoverage(criteria, bindings, new Set(bindings.flatMap(binding => binding.verifierRefs))).ok).toBe(true);
		expect({ source, criteria, bindings, sections, selected: [...selected] }).toEqual(before);
	});
	it('denies empty unknown duplicate or stale section scope and every missing selected criterion without repairing whole specification', () => {
		const source = '# Spec\n## Shared\n- Shared requirement.\n## First project\n- First outcome.\n## Later project\n- Later outcome.\n';
		const criteria = acceptanceCriteria(source), selected = new Set(['proof']);
		const bindings = criteria.map(criterion => ({ criterion: criterion.id, verifierRefs: ['proof'] }));
		for (const sections of [[], [''], [' Spec / Shared'], ['Spec / Missing'], ['Spec / Shared', 'Spec / Shared']]) {
			const before = structuredClone({ criteria, bindings, sections });
			expect(() => acceptanceCoverage(criteria, bindings, selected, sections)).toThrow('Acceptance section');
			expect({ criteria, bindings, sections }).toEqual(before);
		}
		const sections = ['Spec / Shared', 'Spec / First project'];
		for (const changed of [source.replace('Shared requirement.', 'Changed shared requirement.'), source.replace('First outcome.', 'Changed first outcome.'), source.replace('## First project', '- Newly required shared outcome.\n## First project')])
			expect(acceptanceCoverage(acceptanceCriteria(changed), bindings, selected, sections).ok).toBe(false);
		expect(acceptanceCoverage(criteria, bindings.slice(1), selected, sections).ok).toBe(false);
		expect(acceptanceCoverage(criteria, bindings, new Set(), sections).ok).toBe(false);
		expect(acceptanceCoverage(criteria, [...bindings, { criterion: 'stale', verifierRefs: ['proof'] }], selected, sections).ok).toBe(false);
		expect(acceptanceCoverage(criteria, bindings, selected, sections).ok).toBe(true);
		expect(localRequestDiagnostics(['--acceptance-section', sections[0]!])).toHaveLength(1);
		expect(localRequestDiagnostics(['--acceptance-spec', 'acceptance.md', '--acceptance-section', sections[0]!])).toEqual([]);
	});
	it('extracts normative rules, checklist and project requirements without progress diaries', () => {
		const criteria = acceptanceCriteria(document);
		expect(criteria.map(item => item.text)).toEqual(['- Never mutate upstream.', '- Complete both cycles.', 'Required acceptance: exact refs resolve.', 'All projects pass.']);
		expect(criteria[0]?.line).toBe(7);
	});
	it('keeps checkbox evidence out of criterion identity but detects changed requirements', () => {
		expect(acceptanceCriteria(document.replace('[ ]', '[x]'))).toEqual(acceptanceCriteria(document));
		expect(acceptanceCriteria(document.replace('both cycles', 'one cycle'))[1]?.id).not.toBe(acceptanceCriteria(document)[1]?.id);
	});
	it('fails closed on missing criteria, stale bindings and absent executable refs', () => {
		const criteria = acceptanceCriteria(document);
		expect(acceptanceCoverage(criteria, [], new Set()).missing).toHaveLength(4);
		const bindings = criteria.map(item => ({ criterion: item.id, verifierRefs: ['proof'] }));
		expect(acceptanceCoverage(criteria, bindings, new Set(['proof'])).ok).toBe(true);
		expect(acceptanceCoverage(criteria, bindings, new Set()).ok).toBe(false);
		expect(acceptanceCoverage(criteria, [{ criterion: 'stale', verifierRefs: ['proof'] }], new Set(['proof'])).ok).toBe(false);
	});
	it('includes nested rules, tables and fenced input contracts and rejects malformed specifications', () => {
		const criteria = acceptanceCriteria('# Spec\n## Inputs\n### Roles\n| Role | Product |\n|---|---|\n| Tester | Failing test |\n\n```yaml\nplanningPercent: 20\n```\n');
		expect(criteria).toHaveLength(3);
		expect(criteria[2]?.text).toContain('planningPercent: 20');
		expect(() => acceptanceCriteria('# Spec\n## Inputs\n```yaml\nvalue: 1')).toThrow('unterminated');
		expect(() => acceptanceCriteria('# Empty')).toThrow('no normative criteria');
	});
	it('binds every authoritative criterion to its own selected executable refs without changing requirements or partial evidence', () => {
		const criteria = acceptanceCriteria(document);
		const bindings = criteria.map((criterion, index) => ({ criterion: criterion.id, verifierRefs: [`proof.${index}`] }));
		const selected = new Set(bindings.flatMap(binding => binding.verifierRefs));
		const before = structuredClone({ criteria, bindings, selected: [...selected], document });
		for (const criterion of criteria)
			expect(criterion.id).toBe(createHash('sha256').update(`${criterion.section}\n${criterion.text}`).digest('hex'));
		expect(acceptanceCoverage(criteria, bindings, selected)).toEqual({
			ok: true, total: 4, covered: 4, missing: [], diagnostics: [],
		});
		expect({ criteria, bindings, selected: [...selected], document }).toEqual(before);
	});
	it('denies new changed removed unbound and nonselected specification criteria without repairing supplied bindings', () => {
		const original = acceptanceCriteria(document);
		const bindings = original.map((criterion, index) => ({ criterion: criterion.id, verifierRefs: [`proof.${index}`] }));
		const selected = new Set(bindings.flatMap(binding => binding.verifierRefs));
		const scenarios = [
			{ criteria: acceptanceCriteria(`${document}\nNew native outcome is required.\n`), bindings, selected },
			{ criteria: acceptanceCriteria(document.replace('both cycles', 'three cycles')), bindings, selected },
			{ criteria: acceptanceCriteria(document.replace('- Never mutate upstream.\n', '')), bindings, selected },
			{ criteria: original, bindings: bindings.slice(1), selected },
			{ criteria: original, bindings: bindings.map((binding, index) => index === 1 ? { ...binding, verifierRefs: [] } : binding), selected },
			{ criteria: original, bindings: bindings.map((binding, index) => index === 1 ? { ...binding, verifierRefs: ['missing.native'] } : binding), selected },
			{ criteria: original, bindings, selected: new Set(['proof.0']) },
			{ criteria: original, bindings, selected: new Set<string>() },
		];
		const expected = [
			{ total: 5, covered: 4, missing: 1, diagnostics: 1 },
			{ total: 4, covered: 3, missing: 1, diagnostics: 2 },
			{ total: 3, covered: 3, missing: 0, diagnostics: 1 },
			{ total: 4, covered: 3, missing: 1, diagnostics: 1 },
			{ total: 4, covered: 3, missing: 1, diagnostics: 2 },
			{ total: 4, covered: 3, missing: 1, diagnostics: 2 },
			{ total: 4, covered: 1, missing: 3, diagnostics: 6 },
			{ total: 4, covered: 0, missing: 4, diagnostics: 8 },
		];
		for (const [index, scenario] of scenarios.entries()) {
			const before = structuredClone({ ...scenario, selected: [...scenario.selected] });
			const coverage = acceptanceCoverage(scenario.criteria, scenario.bindings, scenario.selected);
			expect(coverage.ok).toBe(false);
			expect({ total: coverage.total, covered: coverage.covered, missing: coverage.missing.length,
				diagnostics: coverage.diagnostics.length }).toEqual(expected[index]);
			for (const missing of coverage.missing) {
				expect(scenario.criteria).toContainEqual(missing);
				expect(coverage.diagnostics).toContain(`Uncovered acceptance criterion at line ${missing.line}: ${missing.section} [${missing.id}].`);
			}
			expect({ ...scenario, selected: [...scenario.selected] }).toEqual(before);
		}
		expect(acceptanceCoverage(original, bindings, selected).ok).toBe(true);
	});
});
