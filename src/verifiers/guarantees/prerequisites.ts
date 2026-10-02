import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';
import type { LocalGuaranteePlan } from './command.ts';

type Row = Record<string, unknown>;
const row = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};

export function ownerTestCommand(root: string): string {
	const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
	const scripts = manifest.scripts ?? {}, visited = new Set<string>();
	let name = 'test';
	for (;;) {
		if (visited.has(name) || scripts[`pre${name}`] || scripts[`post${name}`]) throw new Error('Full prerequisite suite has unresolved delegation or lifecycle hooks.');
		visited.add(name);
		const command = scripts[name];
		if (!command) throw new Error('Full prerequisite test entrypoint is missing.');
		const delegated = /^npm run ([\w:-]+)$/u.exec(command);
		if (!delegated) return command;
		name = delegated[1]!;
	}
}

export function fullSuitePassed(value: unknown): boolean {
	const report = row(value);
	if (report.success !== true || !Number.isInteger(report.numTotalTests) || Number(report.numTotalTests) <= 0
		|| report.numPassedTests !== report.numTotalTests || report.numFailedTests !== 0
		|| report.numPendingTests !== 0 || report.numTodoTests !== 0 || report.numFailedTestSuites !== 0
		|| report.numPendingTestSuites !== 0 || !Array.isArray(report.testResults)) return false;
	const assertions = report.testResults.flatMap(file => Array.isArray(row(file).assertionResults) ? row(file).assertionResults as unknown[] : []);
	return assertions.length === report.numTotalTests && assertions.every(value => {
		const assertion = row(value);
		return assertion.status === 'passed' && typeof assertion.title === 'string' && assertion.title.length > 0
			&& typeof assertion.duration === 'number' && Number.isFinite(assertion.duration) && assertion.duration >= 0;
	});
}

function candidate(root: string) {
	const head = spawnSync('git', ['rev-parse', '--verify', 'HEAD^{commit}'], { cwd: root, encoding: 'utf8' });
	const files = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' });
	if (head.status !== 0 || files.status !== 0) throw new Error('Full prerequisite suite requires exact Git candidate custody.');
	const digest = createHash('sha256');
	for (const path of [...new Set(files.stdout.split('\0').filter(Boolean))].sort()) {
		digest.update(path); digest.update('\0');
		try { digest.update(readFileSync(resolve(root, path))); } catch { digest.update('missing'); }
		digest.update('\0');
	}
	return { commit: head.stdout.trim(), sourceDigest: digest.digest('hex') };
}

/** Complete declared owner suites, once per invocation, before any scene starts. */
export function runPrerequisites(plan: LocalGuaranteePlan, output: string) {
	const roots = [...new Set(plan.entries.flatMap(entry => entry.verifierRefs.map(ref => realpathSync(plan.verifiers[ref]!.root))))];
	const receipts: string[] = [], diagnostics: string[] = [];
	for (const root of roots) {
		const receiptPath = resolve(output, 'evidence', `prerequisite-${createHash('sha256').update(root).digest('hex')}.json`);
		let passed = false, reason = '', custody: ReturnType<typeof candidate> | null = null;
		let command: string[] = [], status: number | null = null, signal: string | null = null, checks: unknown = null;
		const startedAt = new Date().toISOString();
		try {
			custody = candidate(root);
			const script = ownerTestCommand(root);
			const match = /^vitest run(?: --config (\S+))?$/u.exec(script);
			if (!match) throw new Error('Full prerequisite suite needs a supported unfiltered machine-readable test entrypoint.');
			const config = match[1] ? realpathSync(resolve(root, match[1])) : null;
			const configPath = config ? relative(root, config) : '';
			if (configPath === '..' || configPath.startsWith(`..${sep}`) || configPath.startsWith(sep)) throw new Error('Full prerequisite test config escapes its owner.');
			command = [realpathSync(resolve(root, 'node_modules/vitest/vitest.mjs')), 'run', ...(config ? ['--config', config] : []), '--reporter=json'];
			const result = spawnSync(process.execPath, command, { cwd: root, encoding: 'utf8', timeout: 1_200_000, maxBuffer: 32 * 1024 * 1024 });
			status = result.status; signal = result.signal;
			const report = JSON.parse(result.stdout);
			checks = { total: report.numTotalTests, passed: report.numPassedTests, failed: report.numFailedTests,
				skipped: report.numPendingTests, todo: report.numTodoTests };
			const after = candidate(root);
			passed = status === 0 && !result.error && fullSuitePassed(report) && after.commit === custody.commit && after.sourceDigest === custody.sourceDigest;
			if (!passed) reason = 'Full prerequisite suite failed, skipped assertions, lacked complete evidence, or changed the candidate.';
		} catch { reason = 'Full prerequisite suite entrypoint, execution, evidence, or exact candidate custody is unavailable.'; }
		writeFileSync(receiptPath, JSON.stringify({ root, ...custody, command: [process.execPath, ...command], startedAt,
			completedAt: new Date().toISOString(), passed, exitCode: status, signal, checks, reason }, null, 2));
		receipts.push(relative(output, receiptPath));
		if (!passed) diagnostics.push(`${root}: prerequisite unit/integration suite did not pass. ${reason}`);
	}
	return { receipts, diagnostics };
}
