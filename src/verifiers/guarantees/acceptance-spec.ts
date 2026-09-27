import { createHash } from 'node:crypto';

export interface AcceptanceCriterion { id: string; section: string; line: number; text: string }
export interface AcceptanceBinding { criterion: string; verifierRefs: string[] }

// The specification stays authoritative. Digests bind exact requirements, not a
// copied checklist whose text can silently diverge. Checkbox state is evidence,
// not part of the requirement; every other byte of its normalized text is bound.
export function acceptanceCriteria(markdown: string): AcceptanceCriterion[] {
	const criteria: AcceptanceCriterion[] = [];
	const headings: string[] = [];
	let section = '', excluded = false, fence = false, block: string[] = [], line = 0;
	const flush = () => {
		if (!block.length) return;
		const text = block.join('\n').trim().replace(/^[-*] \[[ xX]\] /u, '- ');
		const id = createHash('sha256').update(`${section}\n${text}`).digest('hex');
		criteria.push({ id, section, line, text });
		block = [];
	};
	for (const [index, value] of markdown.split('\n').entries()) {
		const heading = /^(#{1,6}) (.+)$/u.exec(value);
		if (heading && !fence) {
			flush();
			const depth = heading[1]!.length;
			headings.length = depth - 1;
			headings[depth - 1] = heading[2]!;
			section = headings.filter(Boolean).join(' / ');
			excluded = depth === 1 || headings[1] === 'Purpose' || headings[1] === 'Progress record';
			continue;
		}
		if (excluded || !section) continue;
		if (/^```/u.test(value)) {
			if (!fence) { flush(); line = index + 1; }
			block.push(value); fence = !fence;
			if (!fence) flush();
			continue;
		}
		if (fence) { block.push(value); continue; }
		if (!value.trim()) { flush(); continue; }
		// Table headings/separators carry structure; each data row is one boundary.
		if (/^\|[\s:|-]+\|$/u.test(value)) { flush(); continue; }
		if (/^(?:[-*] |\d+\. |\|)/u.test(value)) {
			flush(); line = index + 1; block.push(value); flush(); continue;
		}
		if (!block.length) line = index + 1;
		block.push(value);
	}
	flush();
	if (fence) throw new Error('Acceptance specification has an unterminated code fence.');
	if (!criteria.length) throw new Error('Acceptance specification has no normative criteria.');
	return criteria;
}

export function acceptanceCoverage(criteria: AcceptanceCriterion[], bindings: AcceptanceBinding[], verifiers: Set<string>) {
	const diagnostics: string[] = [];
	const known = new Set(criteria.map(criterion => criterion.id));
	const covered = new Set<string>();
	for (const binding of bindings) {
		if (!known.has(binding.criterion)) { diagnostics.push(`Unknown or changed acceptance criterion ${binding.criterion}.`); continue; }
		if (!Array.isArray(binding.verifierRefs) || !binding.verifierRefs.length
			|| binding.verifierRefs.some(ref => !verifiers.has(ref))) {
			diagnostics.push(`Acceptance criterion ${binding.criterion} has no selected executable verifier binding.`); continue;
		}
		covered.add(binding.criterion);
	}
	const missing = criteria.filter(criterion => !covered.has(criterion.id));
	for (const criterion of missing) diagnostics.push(`Uncovered acceptance criterion at line ${criterion.line}: ${criterion.section} [${criterion.id}].`);
	return { ok: diagnostics.length === 0, total: criteria.length, covered: covered.size, missing, diagnostics };
}
