#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { parse } from 'yaml';
import { acceptanceCriteria, acceptanceCoverage, type AcceptanceBinding } from './acceptance-spec.ts';
import { runPrerequisites, ownerTestCommand, custodyDiagnostics } from './prerequisites.ts';
import type { GuaranteeDiagnostic, GuaranteePlanEntry, GuaranteePlanReport, GuaranteeRunReport, GuaranteeRunStep, GuaranteeRunStatus, GuaranteeVerifierDefinition } from '@treeseed/sdk/guarantees';

type Row = Record<string, unknown>;
export interface LocalGuaranteePlan extends GuaranteePlanReport {
	entries: Array<GuaranteePlanEntry & { manifest: Row; verifierRefs: string[]; scope?: string }>;
	verifiers: Record<string, { definition: GuaranteeVerifierDefinition; root: string }>;
}
const diagnostic = (message: string): GuaranteeDiagnostic => ({ severity: 'error', code: 'guarantee.verification_failed', message });
export function verifierTimeout(value: unknown): number {
	if (value === undefined) return 120_000;
	if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 86_400_000)
		throw new Error('Verifier timeoutMs must be an integer from 1 to 86400000 milliseconds.');
	return value;
}
export function localRequestDiagnostics(args: string[]): GuaranteeDiagnostic[] {
	const supported = new Set(['--workspace', '--ids', '--plan', '--run-id', '--environment', '--acceptance-spec']);
	const errors = args.filter(arg => arg.startsWith('--') && !supported.has(arg))
		.map(arg => diagnostic(`Unsupported local component option ${arg}; no evidence was executed.`));
	const environment = args.indexOf('--environment');
	if (environment >= 0 && args[environment + 1] !== 'local')
		errors.push(diagnostic('Local component tests cannot attest a staging or production environment.'));
	return errors;
}
function files(root: string, suffix: string): string[] {
	if (!existsSync(root)) return [];
	return readdirSync(root, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
		? files(resolve(root, entry.name), suffix) : entry.name.endsWith(suffix) ? [resolve(root, entry.name)] : []);
}
function refs(value: unknown): string[] {
	if (!value || typeof value !== 'object') return [];
	return Object.entries(value).flatMap(([key, child]) => key === 'verifierRefs' && Array.isArray(child)
		? child.map(String) : refs(child));
}
function inside(root: string, path: string): string {
	const target = realpathSync(resolve(root, path));
	const diff = relative(realpathSync(root), target);
	if (diff === '..' || diff.startsWith(`..${sep}`) || diff.startsWith(sep)) throw new Error('Verifier path escapes its owner package.');
	return target;
}
export function planLocalGuarantees(root: string, ids: string[]): LocalGuaranteePlan {
	const packageRoots = existsSync(resolve(root, 'packages'))
		? readdirSync(resolve(root, 'packages'), { withFileTypes: true }).filter(e => e.isDirectory()).map(e => resolve(root, 'packages', e.name))
		: [root];
	const plan: LocalGuaranteePlan = { ok: false, entries: [], verifiers: {}, diagnostics: [] };
	const fail = (message: string) => { plan.diagnostics.push(diagnostic(message)); };
	const manifests = new Map<string, { root: string; path: string; manifest: Row }>();
	const duplicateVerifiers = new Set<string>(), duplicateGuarantees = new Set<string>();
	for (const packageRoot of packageRoots) {
		for (const path of files(resolve(packageRoot, 'guarantees'), '.verifiers.yaml')) {
			const registry = parse(readFileSync(path, 'utf8')) as { verifiers?: Record<string, GuaranteeVerifierDefinition> };
			for (const [id, definition] of Object.entries(registry.verifiers ?? {})) {
				if (plan.verifiers[id]) duplicateVerifiers.add(id);
				else plan.verifiers[id] = { definition, root: packageRoot };
			}
		}
		for (const path of files(resolve(packageRoot, 'guarantees'), '.guarantee.yaml')) {
			const manifest = parse(readFileSync(path, 'utf8')) as Row;
			const id = String(manifest.id);
			if (manifests.has(id)) duplicateGuarantees.add(id);
			else manifests.set(id, { root: packageRoot, path, manifest });
		}
	}
	const pending = [...ids], visited = new Set<string>();
	while (pending.length) {
		const id = pending.shift()!;
		if (visited.has(id)) continue;
		visited.add(id);
		const found = manifests.get(id);
		if (!found) { fail(`Missing guarantee ${id}.`); continue; }
		if (duplicateGuarantees.has(id)) fail(`Duplicate guarantee ${id}.`);
		if (found.manifest.proof || found.manifest.outcomes || found.manifest.activation)
			fail(`${id}: Live outcome/activation requirements cannot be attested by local component tests.`);
		for (const section of ['api', 'content', 'audit']) {
			const contract = found.manifest[section] as { required?: boolean; verifierRefs?: string[] } | undefined;
			if (contract?.required && !contract.verifierRefs?.length)
				fail(`${id}: Required ${section} has no executable verifier.`);
		}
		for (const negative of (found.manifest.negativeCases ?? []) as Array<{ id?: string; verifierRefs?: string[] }>)
			if (!negative.verifierRefs?.length) fail(`${id}: Negative case ${negative.id ?? '(unnamed)'} has no executable verifier.`);
		const scene = found.manifest.scene as { required?: boolean; manifest?: string } | undefined;
		const sceneRefs: string[] = [];
		let scope = 'local-component-tests';
		if (scene?.required) {
			try {
				if (!scene.manifest) throw new Error('Required scene manifest is missing.');
				const document = parse(readFileSync(inside(found.root, scene.manifest), 'utf8')) as {
					scope?: string; workflow?: Array<{ id?: string; demoOnly?: boolean; action?: { verifier?: string }; expect?: { status?: string } }>;
				};
				scope = document.scope ?? scope;
				if (!['local-component-tests', 'local-integrated-runtime'].includes(scope)) throw new Error('Unsupported local scene evidence scope.');
				if (!document.workflow?.length) throw new Error('Required scene has no executable steps.');
				const stepIds = new Set<string>();
				for (const step of document.workflow) {
					if (!step.id || stepIds.has(step.id) || step.demoOnly || !step.action?.verifier || step.expect?.status !== 'passed')
						throw new Error('Component scene requires unique, non-demo verifier steps with passed assertions.');
					stepIds.add(step.id);
					sceneRefs.push(step.action.verifier);
				}
			} catch (error) { fail(`${id}: ${error instanceof Error ? error.message : 'Invalid required scene.'}`); }
		}
		const verifierRefs = [...new Set([...refs(found.manifest), ...sceneRefs])];
		if (!verifierRefs.length) fail(`Guarantee ${id} has no executable verifiers.`);
		for (const ref of verifierRefs) {
			if (duplicateVerifiers.has(ref)) fail(`Duplicate verifier ${ref}.`);
			const verifier = plan.verifiers[ref];
			if (!verifier) { fail(`Missing verifier ${ref}.`); continue; }
			if (verifier.definition.kind !== 'vitestCase' && verifier.definition.kind !== 'nodeTestCase') { fail(`Local test execution is not configured for ${ref}.`); continue; }
			if (scope === 'local-integrated-runtime' && verifier.definition.kind !== 'nodeTestCase') fail(`${ref}: Integrated runtime read-back requires an explicit native Node acceptance test.`);
			try {
				verifierTimeout(Reflect.get(verifier.definition, 'timeoutMs'));
				inside(verifier.root, verifier.definition.testFile);
				if (!verifier.definition.testName) throw new Error('An exact test name is required.');
			} catch (error) { fail(`${ref}: ${error instanceof Error ? error.message : 'Invalid verifier.'}`); }
		}
		const dependencies = found.manifest.dependencies as { guarantees?: string[] } | undefined;
		pending.push(...(dependencies?.guarantees ?? []));
		plan.entries.push({ id, sourcePath: relative(root, found.path), manifest: found.manifest, verifierRefs, sceneVerifierRefs: sceneRefs, scope,
			journey: String(found.manifest.journey ?? id), ownerPackage: String(found.manifest.ownerPackage ?? ''),
			type: String(found.manifest.type ?? ''), subtype: String(found.manifest.subtype ?? ''), status: String(found.manifest.status ?? 'planned'),
			gates: Array.isArray(found.manifest.gates) ? found.manifest.gates.map(String) : [], selected: ids.includes(id), dependency: !ids.includes(id) });
	}
	if (!ids.length) fail('Select explicit guarantee IDs; an empty run cannot pass.');
	if (new Set(plan.entries.map(entry => entry.scope)).size > 1) fail('Component and integrated runtime evidence must run separately.');
	const visiting = new Set<string>(), finished = new Set<string>(), order: string[] = [];
	function visit(id: string): void {
		if (visiting.has(id)) { fail(`Cyclic guarantee dependency ${id}.`); return; }
		if (finished.has(id)) return;
		visiting.add(id);
		const dependencies = manifests.get(id)?.manifest.dependencies as { guarantees?: string[] } | undefined;
		for (const dependency of dependencies?.guarantees ?? []) if (visited.has(dependency)) visit(dependency);
		visiting.delete(id); finished.add(id); order.push(id);
	}
	for (const id of ids) visit(id);
	plan.entries.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
	plan.ok = plan.diagnostics.length === 0;
	return plan;
}
export function runLocalGuarantees(root: string, plan: LocalGuaranteePlan, runId: string = randomUUID()) {
	if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(runId)) throw new Error('Unsafe guarantee run ID.');
	const output = resolve(root, '.treeseed/guarantees/runs', runId);
	if (existsSync(output)) throw new Error('Guarantee evidence is immutable; run ID already exists.');
	mkdirSync(resolve(output, 'evidence'), { recursive: true });
	const startedAt = new Date().toISOString();
	const scope = plan.entries[0]?.scope ?? 'local-component-tests';
	const checks = new Map<string, { status: 'passed' | 'failed' | 'blocked'; evidence: string[]; diagnostics: GuaranteeDiagnostic[] }>();
	const blockedGuarantees = new Set<string>(), passedGuarantees = new Set<string>();
	const prerequisites = plan.ok ? runPrerequisites(plan, output, root) : { receipts: [], diagnostics: [], candidates: new Map() };
	const prerequisiteDiagnostics = prerequisites.diagnostics.map(diagnostic);
	if (plan.ok && !prerequisiteDiagnostics.length) for (const entry of plan.entries) {
		const dependencies = entry.manifest.dependencies as { guarantees?: string[] } | undefined;
		if (dependencies?.guarantees?.some(id => !passedGuarantees.has(id))) { blockedGuarantees.add(entry.id); continue; }
		let failedSceneStep = false;
		for (const ref of entry.verifierRefs) {
		if (failedSceneStep && entry.sceneVerifierRefs?.includes(ref)) {
			checks.set(ref, { status: 'blocked', evidence: [], diagnostics: [diagnostic('An earlier scene step did not pass.')] });
			continue;
		}
		if (checks.has(ref)) continue;
		const custodyErrors = custodyDiagnostics(prerequisites.candidates).map(diagnostic);
		if (custodyErrors.length) {
			checks.set(ref, { status: 'blocked', evidence: [], diagnostics: custodyErrors });
			continue;
		}
		const binding = plan.verifiers[ref]!;
		if (binding.definition.kind !== 'vitestCase' && binding.definition.kind !== 'nodeTestCase') continue;
		const { testFile, testName } = binding.definition;
		const reportPath = resolve(output, 'evidence', `${createHash('sha256').update(ref).digest('hex')}.json`);
		const sourceDigest = createHash('sha256').update(readFileSync(inside(binding.root, testFile))).digest('hex');
		const testCommand = ownerTestCommand(binding.root);
		const config = /--config\s+(\S+)/.exec(testCommand)?.[1];
		const args = binding.definition.kind === 'vitestCase'
			? [inside(binding.root, 'node_modules/vitest/vitest.mjs'), 'run', ...(config ? ['--config', inside(binding.root, config)] : []), testFile,
				'-t', `^.*${testName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, '--reporter=json']
			: [...(import.meta.url.endsWith('.ts') ? ['--import', createRequire(import.meta.url).resolve('tsx')] : []),
				fileURLToPath(new URL(`./node-case.${import.meta.url.endsWith('.ts') ? 'ts' : 'js'}`, import.meta.url)), inside(binding.root, testFile), testName];
		const timeoutMs = verifierTimeout(Reflect.get(binding.definition, 'timeoutMs'));
		const result = spawnSync(process.execPath, args, { cwd: binding.root, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
		let passed = false;
		let observed: Array<{ title: string; status: string; duration: number; failure?: unknown }> = [];
		try {
			const report = JSON.parse(result.stdout) as { success: boolean; numPassedTests: number; numFailedTests: number;
				testResults: Array<{ assertionResults: Array<{ title: string; status: string; duration?: number; failure?: unknown }> }> };
			observed = report.testResults.flatMap(file => file.assertionResults).filter(check => check.title === testName)
				.map(check => ({ title: check.title, status: check.status, duration: check.duration ?? Number.NaN,
					...(check.failure ? { failure: check.failure } : {}) }));
			passed = result.status === 0 && report.success === true && Number.isInteger(report.numPassedTests)
				&& report.numPassedTests > 0 && report.numFailedTests === 0 && observed.length === report.numPassedTests
				&& observed.every(check => check.status === 'passed' && Number.isFinite(check.duration) && check.duration >= 0);
		} catch { /* Missing/malformed evidence fails closed. */ }
		const afterCustodyErrors = custodyDiagnostics(prerequisites.candidates).map(diagnostic);
		passed = passed && !afterCustodyErrors.length;
		writeFileSync(reportPath, JSON.stringify({ verifierId: ref, scope, testFile, testName, sourceDigest,
			timeoutMs, processErrorCode: result.error && 'code' in result.error ? result.error.code : null,
			exitCode: result.status, signal: result.signal, passed, checks: observed, diagnostics: afterCustodyErrors }, null, 2));
		checks.set(ref, { status: passed ? 'passed' : 'failed', evidence: [relative(output, reportPath)], diagnostics: passed ? [] : [diagnostic('Exact coded verifier did not pass.'), ...afterCustodyErrors] });
		if (!passed && entry.sceneVerifierRefs?.includes(ref)) failedSceneStep = true;
		}
		if (entry.verifierRefs.every(ref => checks.get(ref)?.status === 'passed')) passedGuarantees.add(entry.id);
	}
	const results = plan.entries.map(entry => {
		const steps: GuaranteeRunStep[] = entry.verifierRefs.map(id => ({ id, ref: id, kind: entry.sceneVerifierRefs?.includes(id) ? 'scene' : 'verifier', ...(blockedGuarantees.has(entry.id)
			? { status: 'blocked' as const, evidence: [], diagnostics: [diagnostic('A prerequisite guarantee did not pass.')] }
			: checks.get(id) ?? { status: 'blocked', evidence: [], diagnostics: [...plan.diagnostics, ...prerequisiteDiagnostics] }) }));
		const status: GuaranteeRunStatus = steps.some(s => s.status === 'failed') ? 'failed' : steps.length && steps.every(s => s.status === 'passed') ? 'passed' : 'blocked';
		return { ...entry, status, steps, evidence: [...steps.flatMap(s => s.evidence ?? []), ...prerequisites.receipts], diagnostics: steps.flatMap(s => s.diagnostics ?? []) };
	});
	const counts = { passed: results.filter(r => r.status === 'passed').length, failed: results.filter(r => r.status === 'failed').length,
		blocked: results.filter(r => r.status === 'blocked').length, skipped: 0, releaseBlockingFailures: 0 };
	const report: GuaranteeRunReport = { schemaVersion: 'treeseed.guarantee-run/v1', runId, environment: 'local', scope, startedAt, completedAt: new Date().toISOString(),
		ok: plan.ok && results.length > 0 && counts.passed === results.length, filter: {}, counts, results, diagnostics: [...plan.diagnostics, ...prerequisiteDiagnostics] };
	writeFileSync(resolve(output, 'plan.json'), JSON.stringify(plan, null, 2));
	writeFileSync(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
	return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	const option = (name: string) => { const index = process.argv.indexOf(`--${name}`); return index < 0 ? '' : process.argv[index + 1] ?? ''; };
	const root = resolve(option('workspace') || process.cwd());
	const plan = planLocalGuarantees(root, option('ids').split(',').filter(Boolean));
	if (option('acceptance-spec')) {
		try {
			const criteria = acceptanceCriteria(readFileSync(resolve(root, option('acceptance-spec')), 'utf8'));
			const bindings = plan.entries.flatMap(entry => (entry.manifest.acceptanceCriteria ?? []) as AcceptanceBinding[]);
			const selected = new Set(plan.entries.flatMap(entry => entry.verifierRefs));
			const coverage = acceptanceCoverage(criteria, bindings, selected);
			plan.diagnostics.push(...coverage.diagnostics.map(diagnostic));
		} catch (error) { plan.diagnostics.push(diagnostic(error instanceof Error ? error.message : 'Invalid acceptance specification.')); }
	}
	plan.diagnostics.push(...localRequestDiagnostics(process.argv.slice(2)));
	plan.ok = plan.diagnostics.length === 0;
	const report = process.argv.includes('--plan') ? plan : runLocalGuarantees(root, plan, option('run-id') || randomUUID());
	process.stdout.write(`${JSON.stringify(report)}\n`);
	if (!report.ok) process.exitCode = 1;
}
