import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdtempSync, openSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { parse } from 'yaml';
import type { LocalGuaranteePlan } from './command.ts';
import { failureCriterion } from './safe-cli-failure.ts';

type Row = Record<string, unknown>;
const row = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};

export function ownerTestCommand(root: string): string {
	if (!existsSync(resolve(root,'package.json'))) {
		const declared = row(row(parse(readFileSync(resolve(root,'treeseed.package.yaml'),'utf8'))).verify).local;
		if (typeof declared !== 'string' || !/^[\w.][\w./-]*\.(?:exs|sh)$/u.test(declared)
			|| declared.split('/').includes('..'))
			throw new Error('Full native prerequisite reporting requires one declared native verification entrypoint.');
		return `${declared.endsWith('.exs') ? 'elixir' : 'bash'} ${declared}`;
	}
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

function fullTestEntrypoint(root: string) {
	const script=ownerTestCommand(root);
	const vitest=/^vitest run(?: --config (\S+))?$/u.exec(script);
	const native=/^(?:npm run [\w:-]+ && )?node(?: --import tsx)? ([\w./-]+\.(?:ts|js|mjs))$/u.exec(script);
	const elixir=!existsSync(resolve(root,'package.json')) ? /^elixir ([\w./-]+\.exs)$/u.exec(script) : null;
	const shell=!existsSync(resolve(root,'package.json')) ? /^bash ([\w./-]+\.sh)$/u.exec(script) : null;
	if(!vitest&&!native&&!elixir&&!shell)throw new Error('Full prerequisite reporting requires an unfiltered declared entrypoint.');
	const selected=vitest?.[1]??native?.[1]??elixir?.[1]??shell?.[1];
	const path=selected?realpathSync(resolve(root,selected)):null;
	const local=path?relative(root,path):'';
	if(local==='..'||local.startsWith(`..${sep}`)||local.startsWith(sep))
		throw new Error('Full prerequisite entrypoint escapes its owner.');
	if(path)readFileSync(path); // A directory or unreadable entrypoint is not an executable suite.
	return {config:vitest?path:null,native:Boolean(native),elixir:elixir?path:null,shell:shell?path:null};
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

export function fullSuiteFailures(value: unknown) {
	const files=row(value).testResults;
	return Array.isArray(files) ? files.flatMap(file=>{
		const assertions=row(file).assertionResults;
		return Array.isArray(assertions) ? assertions.filter(value=>row(value).status!=='passed').map(value=>{
			const assertion=row(value), messages=assertion.failureMessages;
			const criterion=Array.isArray(messages)?messages.flatMap(message=>
				typeof message==='string' ? failureCriterion(message) ?? [] : []).at(0):undefined;
			return {title:assertion.title,status:assertion.status,...(criterion?{criterion}:{})};
		}) : [];
	}) : [];
}

export function candidate(root: string) {
	const top = spawnSync('git', ['rev-parse', '--show-toplevel', '--absolute-git-dir'], { cwd: root, encoding: 'utf8' });
	const [worktree, directory] = top.stdout.trim().split(/\r?\n/u);
	const own = spawnSync('git', ['rev-parse', '--resolve-git-dir', resolve(root, '.git')], { cwd: root, encoding: 'utf8' });
	if (top.status !== 0 || !worktree || !directory || own.status !== 0
		|| realpathSync(worktree) !== realpathSync(root) || realpathSync(directory) !== realpathSync(own.stdout.trim()))
		throw new Error('Full prerequisite suite requires its own exact Git source root.');
	const head = spawnSync('git', ['rev-parse', '--verify', 'HEAD^{commit}'], { cwd: root, encoding: 'utf8' });
	const files = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' });
	const index = spawnSync('git', ['ls-files', '--stage', '-z'], { cwd: root, encoding: 'utf8' });
	if (head.status !== 0 || files.status !== 0 || index.status !== 0) throw new Error('Full prerequisite suite requires exact Git candidate custody.');
	const gitlinks = new Map<string,string>();
	for (const entry of index.stdout.split('\0').filter(Boolean)) {
		const match=/^160000 ([a-f0-9]{40,64}) ([0-3])\t([\s\S]+)$/u.exec(entry);
		if (!match) continue;
		if (match[2] !== '0' || gitlinks.has(match[3]!)) throw new Error('Full prerequisite submodule pin is unresolved.');
		gitlinks.set(match[3]!,match[1]!);
	}
	const digest = createHash('sha256'), canonicalRoot=realpathSync(root);
	for (const path of [...new Set(files.stdout.split('\0').filter(Boolean))].sort()) {
		const source=resolve(canonicalRoot,path), metadata=lstatSync(source);
		const link=metadata.isSymbolicLink()?readlinkSync(source):null, actual=realpathSync(source), local=relative(canonicalRoot,actual);
		if(local==='..'||local.startsWith(`..${sep}`)||local.startsWith(sep))throw new Error('Full prerequisite source escapes its owner.');
		const pin=gitlinks.get(path);
		if (pin) {
			if (metadata.isSymbolicLink()) throw new Error('Full prerequisite submodule root must not be redirected.');
			const nested=candidate(actual);
			if (nested.commit !== pin) throw new Error('Full prerequisite submodule HEAD differs from its exact Gitlink pin.');
			digest.update(JSON.stringify([path,'160000',pin,nested.sourceDigest])).update('\0');
			continue;
		}
		const target=lstatSync(actual);
		if(!target.isFile()||(target.mode&0o444)===0)throw new Error('Full prerequisite source requires readable regular bytes.');
		const descriptor=openSync(actual,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
		try {
			const opened=fstatSync(descriptor);
			if(!opened.isFile()||(opened.mode&0o444)===0||opened.ino!==target.ino||opened.dev!==target.dev)
				throw new Error('Full prerequisite source requires readable regular bytes.');
			const bytes=readFileSync(descriptor), after=fstatSync(descriptor);
			if(after.size!==opened.size||bytes.length!==opened.size||after.mtimeMs!==opened.mtimeMs||after.ctimeMs!==opened.ctimeMs
				||realpathSync(source)!==actual||(link!==null?readlinkSync(source)!==link:lstatSync(source).isSymbolicLink()))
				throw new Error('Full prerequisite source changed while reading.');
			digest.update(JSON.stringify([path,link,opened.mode&0o7777,bytes.length])).update('\0').update(bytes).update('\0');
		} finally {closeSync(descriptor);}
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
		.filter(root => existsSync(resolve(root,'package.json'))||existsSync(resolve(root,'treeseed.package.yaml'))).map(root => realpathSync(root)))];
	const packages = new Map<string,string[]>(), projects = new Map<string,string[]>(), documents = new Map<string,Row>();
	const index = (map: Map<string,string[]>, id: unknown, root: string) => {
		if (typeof id === 'string' && id) map.set(id,[...(map.get(id) ?? []),root]);
	};
	for (const root of catalog) {
		if(existsSync(resolve(root,'package.json')))
			index(packages,row(JSON.parse(readFileSync(resolve(root,'package.json'),'utf8'))).name,root);
		const path = resolve(root,'treeseed.package.yaml');
		if (!existsSync(path)) continue;
		const metadata=row(parse(readFileSync(path,'utf8')));
		if(!existsSync(resolve(root,'package.json')))index(packages,metadata.id,root);
		const development = row(metadata.development);
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
export function runPrerequisites(plan: LocalGuaranteePlan, output: string, workspace: string, executingOwner?:string) {
	const receipts: string[] = [], diagnostics: string[] = [];
	const candidates = new Map<string, ReturnType<typeof candidate>>();
	let roots: string[];
	try { roots = [...new Set([...participatingOwners(plan,workspace),...(executingOwner?[executingOwner]:[])])]; }
	catch { return {receipts,candidates,diagnostics:['Participating prerequisite owner composition is missing, malformed or ambiguous.']}; }
	// Identify every supported whole-suite boundary before spending capacity on any owner.
	const entrypoints=new Map<string,ReturnType<typeof fullTestEntrypoint>>();
	for(const root of roots) {
		try {entrypoints.set(root,fullTestEntrypoint(root));}
		catch {diagnostics.push(`${root}: complete prerequisite suite entrypoint or native reporting is unavailable.`);}
	}
	const admitted=diagnostics.length===0;
	for (const root of roots) {
		const receiptPath = resolve(output, 'evidence', `prerequisite-${createHash('sha256').update(root).digest('hex')}.json`);
		let passed = false, reason = '', custody: ReturnType<typeof candidate> | null = null;
		let command: string[] = [], status: number | null = null, signal: string | null = null, checks: unknown = null;
		let temporary: string | undefined;
		let reporter: string | undefined, reporterDigest: string | undefined;
		const startedAt = new Date().toISOString();
		try {
			custody = candidate(root);
			if(!admitted)throw new Error('A participating full-suite entrypoint is unavailable.');
			const {config,native,elixir,shell}=entrypoints.get(root)!;
			let result, report;
			if (elixir || shell) {
				// The owner's original whole-suite command emits the existing assertion report.
				// Never infer assertions from exit zero or recover JSON from mixed stdout.
				command = elixir ? ['elixir',elixir] : ['bash',shell!];
				result = spawnSync(command[0]!,command.slice(1),{cwd:root,encoding:'utf8',timeout:1_200_000,maxBuffer:32*1024*1024});
				status = result.status; signal = result.signal;
				report = JSON.parse(result.stdout);
			} else if (!native) {
				// Native child tools may inherit stdout; consume only Vitest's own report file.
				temporary = mkdtempSync(resolve(tmpdir(),'guarantee-vitest-suite-'));
				const destination = resolve(temporary,'report.json');
				command = [process.execPath,realpathSync(resolve(root, 'node_modules/vitest/vitest.mjs')), 'run', ...(config ? ['--config', config] : []), '--reporter=json', `--outputFile=${destination}`];
				result = spawnSync(command[0]!, command.slice(1), { cwd: root, encoding: 'utf8', timeout: 1_200_000, maxBuffer: 32 * 1024 * 1024 });
				status = result.status; signal = result.signal;
				report = JSON.parse(readFileSync(destination,'utf8'));
			} else {
				// Preserve the declared npm entrypoint, including its original build and runner.
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
				failures: fullSuiteFailures(report) };
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
