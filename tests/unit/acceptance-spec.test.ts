import { describe, expect, it } from 'vitest';
import { acceptanceCriteria, acceptanceCoverage } from '../../src/verifiers/guarantees/acceptance-spec.ts';

const document = '# Acceptance\n\n## Purpose\nOverview.\n\n## Rules\n- Never mutate upstream.\n- [ ] Complete both cycles.\n\nRequired acceptance: exact refs resolve.\n\n## Progress record\nTransient diary.\n\n## Completion\nAll projects pass.\n';
describe('authoritative acceptance specification coverage', () => {
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
});
