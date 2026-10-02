import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { parse } from 'yaml';
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

export function candidate(root: string) {
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

export function custodyDiagnostics(candidates: ReadonlyMap<string, ReturnType<typeof candidate>>): string[] {
	return [...candidates].flatMap(([root, expected]) => {
		try {
			const current = candidate(root);
			if (current.commit === expected.commit && current.sourceDigest === expected.sourceDigest) return [];
		} catch { /* Lost custody is not a passing candidate. */ }
		return [`${root}: prerequisite candidate changed or exact Git custody became unavailable.`];
	});
}

/** Reuse declared package owners and runtime target dependencies, never a role/owner list. */
export function participatingOwners(plan: LocalGuaranteePlan, workspace: string): string[] {
	const packageDirectory = resolve(workspace, 'packages');
	const catalog = [...new Set([workspace, ...Object.values(plan.verifiers).map(binding => binding.root),
		...(existsSync(packageDirectory) ? readdirSync(packageDirectory).map(name => resolve(packageDirectory,name)) : [])]
		.filter(root => existsSync(resolve(root,'package.json'))).map(root => realpathSync(root)))];
	const packages = new Map<string,string[]>(), projects = new Map<string,string[]>(), documents = new Map<string,Row>();
	const index = (map: Map<string,string[]>, id: unknown, root: string) => {
		if (typeof id === 'string' && id) map.set(id,[...(map.get(id) ?? []),root]);
	};
	for (const root of catalog) {
		index(packages,row(JSON.parse(readFileSync(resolve(root,'package.json'),'utf8'))).name,root);
		const path = resolve(root,'treeseed.package.yaml');
		if (!existsSync(path)) continue;
		const development = row(row(parse(readFileSync(path,'utf8'))).development);
		documents.set(root,development); index(projects,row(development.project).id,root);
	}
	const unique = (map: Map<string,string[]>, id: string) => {
		const roots = map.get(id);
		if (roots?.length !== 1) throw new Error('Participating owner source is missing or ambiguous.');
		return roots[0]!;
	};
	const owners = new Set<string>();
	for (const entry of plan.entries) {
		if (entry.ownerPackage) owners.add(unique(packages,entry.ownerPackage));
		for (const ref of entry.verifierRefs) owners.add(realpathSync(plan.verifiers[ref]!.root));
	}
	if (!plan.entries.some(entry => entry.scope === 'local-integrated-runtime')) return [...owners];
	const visited = new Set<string>();
	const visit = (root: string, targetId?: string) => {
		const document = documents.get(root), projectId = row(document?.project).id;
		if (typeof projectId !== 'string' || unique(projects,projectId) !== root || !Array.isArray(document?.targets)
			|| !document.targets.length) throw new Error('Integrated owner runtime composition is unavailable.');
		const targets = document.targets.map(row);
		const ids = targets.map(target => target.id);
		if (ids.some(id => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length
			|| (targetId && !ids.includes(targetId))) throw new Error('Integrated dependency target is missing or ambiguous.');
		owners.add(root);
		for (const target of targets.filter(target => !targetId || target.id === targetId)) {
			const key = `${root}\0${target.id}`; if (visited.has(key)) continue; visited.add(key);
			if (target.dependencies !== undefined && !Array.isArray(target.dependencies)) throw new Error('Integrated target dependencies are malformed.');
			for (const value of (target.dependencies ?? []) as unknown[]) {
				const dependency = row(value);
				if (typeof dependency.id !== 'string' || !dependency.id || typeof dependency.target !== 'string' || !dependency.target)
					throw new Error('Integrated dependency identity is unavailable.');
				visit(unique(projects,dependency.id),dependency.target);
			}
		}
	};
	for (const root of [...owners]) visit(root);
	return [...owners];
}

/** Complete declared owner suites, once per invocation, before any scene starts. */
export function runPrerequisites(plan: LocalGuaranteePlan, output: string, workspace: string) {
	const receipts: string[] = [], diagnostics: string[] = [];
	const candidates = new Map<string, ReturnType<typeof candidate>>();
	let roots: string[];
	try { roots = participatingOwners(plan,workspace); }
	catch { return {receipts,candidates,diagnostics:['Participating prerequisite owner composition is missing, malformed or ambiguous.']}; }
	for (const root of roots) {
		const receiptPath = resolve(output, 'evidence', `prerequisite-${createHash('sha256').update(root).digest('hex')}.json`);
		let passed = false, reason = '', custody: ReturnType<typeof candidate> | null = null;
		let command: string[] = [], status: number | null = null, signal: string | null = null, checks: unknown = null;
		let temporary: string | undefined;
		let reporter: string | undefined, reporterDigest: string | undefined;
		const startedAt = new Date().toISOString();
		try {
			custody = candidate(root);
			const script = ownerTestCommand(root);
			const match = /^vitest run(?: --config (\S+))?$/u.exec(script);
			let result, report;
			if (match) {
				const config = match[1] ? realpathSync(resolve(root, match[1])) : null;
				const configPath = config ? relative(root, config) : '';
				if (configPath === '..' || configPath.startsWith(`..${sep}`) || configPath.startsWith(sep)) throw new Error('Full prerequisite test config escapes its owner.');
				command = [process.execPath,realpathSync(resolve(root, 'node_modules/vitest/vitest.mjs')), 'run', ...(config ? ['--config', config] : []), '--reporter=json'];
				result = spawnSync(command[0]!, command.slice(1), { cwd: root, encoding: 'utf8', timeout: 1_200_000, maxBuffer: 32 * 1024 * 1024 });
				status = result.status; signal = result.signal;
				report = JSON.parse(result.stdout);
			} else {
				// Preserve the declared npm entrypoint, including its original build and runner.
				const native = /^(?:npm run [\w:-]+ && )?node(?: --import tsx)? ([\w./-]+\.(?:ts|js|mjs))$/u.exec(script);
				if (!native) throw new Error('Native prerequisite reporting requires an unfiltered declared runner.');
				const runnerPath = relative(root,realpathSync(resolve(root,native[1]!)));
				if (runnerPath === '..' || runnerPath.startsWith(`..${sep}`) || runnerPath.startsWith(sep)) throw new Error('Native full-suite runner escapes its owner.');
				reporter = realpathSync(fileURLToPath(new URL(`./node-case.${import.meta.url.endsWith('.ts') ? 'ts' : 'js'}`,import.meta.url)));
				reporterDigest = createHash('sha256').update(readFileSync(reporter)).digest('hex');
				// Node loads custom reporters before --import hooks. Reuse tsx's scoped
				// import for source execution; compiled execution imports the same module.
				const reporterSpecifier = reporter.endsWith('.ts')
					? `data:text/javascript,${encodeURIComponent(`import {tsImport} from ${JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm/api')).href)};export default (await tsImport(${JSON.stringify(pathToFileURL(reporter).href)},${JSON.stringify(import.meta.url)})).default;`)}`
					: reporter;
				temporary = mkdtempSync(resolve(tmpdir(),'guarantee-native-suite-'));
				const destination = resolve(temporary,'report.json');
				command = ['npm','test','--',`--test-reporter=${reporterSpecifier}`,`--test-reporter-destination=${destination}`];
				result = spawnSync(command[0]!,command.slice(1),{cwd:root,encoding:'utf8',timeout:1_200_000,maxBuffer:32*1024*1024});
				status = result.status; signal = result.signal;
				report = JSON.parse(readFileSync(destination,'utf8'));
			}
			checks = { total: report.numTotalTests, passed: report.numPassedTests, failed: report.numFailedTests,
				skipped: report.numPendingTests, todo: report.numTodoTests,
				failures: Array.isArray(report.testResults) ? report.testResults.flatMap((file: unknown) => {
					const assertions = row(file).assertionResults;
					return Array.isArray(assertions) ? assertions.filter(value=>row(value).status !== 'passed')
						.map(value=>({title:row(value).title,status:row(value).status})) : [];
				}) : [] };
			const after = candidate(root);
			passed = status === 0 && !result.error && fullSuitePassed(report) && after.commit === custody.commit && after.sourceDigest === custody.sourceDigest
				&& (!reporter || createHash('sha256').update(readFileSync(reporter)).digest('hex') === reporterDigest);
			if (!passed) reason = 'Full prerequisite suite failed, skipped assertions, lacked complete evidence, or changed the candidate.';
			else candidates.set(root, custody);
		} catch { reason = 'Full prerequisite suite entrypoint, execution, evidence, or exact candidate custody is unavailable.'; }
		finally { if (temporary) rmSync(temporary,{recursive:true,force:true}); }
		writeFileSync(receiptPath, JSON.stringify({ root, ...custody, command, startedAt,
			completedAt: new Date().toISOString(), passed, exitCode: status, signal, checks, reason }, null, 2));
		receipts.push(relative(output, receiptPath));
		if (!passed) diagnostics.push(`${root}: prerequisite unit/integration suite did not pass. ${reason}`);
	}
	if (!roots.length) diagnostics.push('No participating prerequisite owner has exact candidate custody.');
	diagnostics.push(...custodyDiagnostics(candidates));
	return { receipts, diagnostics, candidates };
}
