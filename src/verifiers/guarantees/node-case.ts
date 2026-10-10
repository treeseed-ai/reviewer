import { run } from 'node:test';
import { createRequire } from 'node:module';
import { delimiter, resolve } from 'node:path';
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { failureCriterion, safeCliFailure } from './safe-cli-failure.ts';

// Normalize Node's named terminal events, never test stdout or secret payloads.
type Row = Record<string, unknown>;
const row = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};

/** Native reporting observes the owner's runner; it never discovers or selects tests. */
export default async function* nativeReporter(source: AsyncIterable<{type: string; data: unknown}>) {
	const assertions: Array<{title: unknown; status: string; duration: unknown}> = [];
	let summaries = 0, summary: Row = {};
	let failedSuites = 0, pendingSuites = 0;
	for await (const event of source) {
		const data = row(event.data), details = row(data.details);
		if (event.type === 'test:summary' && data.file === undefined) { summaries++; summary = data; }
		if ((event.type === 'test:pass' || event.type === 'test:fail') && details.type === 'suite') {
			if (event.type === 'test:fail') failedSuites++;
			if (data.skip || data.todo) pendingSuites++;
		}
		if ((event.type === 'test:pass' || event.type === 'test:fail') && details.type === 'test')
			assertions.push({title:data.name,status:data.skip ? 'skipped' : data.todo ? 'todo' : event.type === 'test:pass' ? 'passed' : 'failed',duration:details.duration_ms});
	}
	const counts = row(summary.counts);
	yield JSON.stringify({success:summaries === 1 && summary.success === true && counts.cancelled === 0,
		numTotalTests:counts.tests,numPassedTests:counts.passed,numFailedTests:counts.failed,
		numPendingTests:counts.skipped,numTodoTests:counts.todo,numFailedTestSuites:failedSuites,numPendingTestSuites:pendingSuites,
		testResults:[{assertionResults:assertions}]});
}

async function namedCase(): Promise<void> {
const [file, name, installedPackages] = process.argv.slice(2);
if (!file || !name) throw new Error('An exact test file and name are required.');
// Archive-declared command links are held by installed custody before dispatch.
// Native commands in the selected test must resolve that installation first.
if (installedPackages) {
	const directory = realpathSync(installedPackages), ownerRoot = realpathSync(process.cwd());
	const owner = JSON.parse(readFileSync(resolve(ownerRoot, 'package.json'), 'utf8')) as { name?: unknown };
	if (typeof owner.name !== 'string' || !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/u.test(owner.name)
		|| ownerRoot !== resolve(directory, owner.name)) throw new Error('Installed native commands cannot fall back to a source owner.');
	process.env.PATH = [resolve(ownerRoot, 'node_modules/.bin'), resolve(directory, '.bin'), process.env.PATH].filter(Boolean).join(delimiter);
}
const pattern = `^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;
const assertions: Array<{ title: string; status: string; duration: number; failure?: { code: string; file: string; line: number; column: number; criterion?: string; cliFailure?: string } }> = [];
let failures = 0;
const loader = createRequire(import.meta.url).resolve('tsx');
const fence=installedPackages?`data:text/javascript,${encodeURIComponent(`import{registerHooks}from'node:module';import{fileURLToPath}from'node:url';import{relative,isAbsolute,sep,resolve}from'node:path';import{realpathSync}from'node:fs';registerHooks({resolve(specifier,context,next){const result=next(specifier,context);if(result.url.startsWith('file:')){const absolute=fileURLToPath(result.url),path=relative(${JSON.stringify(installedPackages)},realpathSync(absolute));if(realpathSync(absolute)!==resolve(absolute)||path==='..'||path.startsWith('..'+sep)||isAbsolute(path))throw new Error('Installed verifier cannot import assets outside installed packages.');}return result;}});`)}`:undefined;
for await (const event of run({ files: [file], testNamePatterns: [pattern], execArgv: [...(fence?['--import',fence]:[]),'--import', loader] })) {
	if (event.type === 'test:fail') failures++;
	if ((event.type === 'test:pass' || event.type === 'test:fail') && event.data.name === name) {
		const error = event.type === 'test:fail' ? event.data.details.error : undefined;
		const cause = error?.cause as Error | undefined;
		const message = String(cause?.message ?? error?.message ?? '');
		const criterion = failureCriterion(message);
		const cliFailure = safeCliFailure(message);
		// Retain source location and error classification, never assertion values,
		// raw CLI payloads, stack dumps, stdout or credential-bearing messages.
		const failure = error ? { code: String(error.code ?? 'test_failed'), file: String(event.data.file ?? ''),
			line: Number(event.data.line ?? 0), column: Number(event.data.column ?? 0), ...(criterion ? { criterion } : {}),
			...(cliFailure ? { cliFailure } : {}) } : undefined;
		assertions.push({ title: name, status: event.data.skip ? 'skipped' : event.type === 'test:pass' ? 'passed' : 'failed',
			duration: event.data.details.duration_ms, ...(failure ? { failure } : {}) });
	}
}
const passed = assertions.filter(assertion => assertion.status === 'passed').length;
const success = passed > 0 && failures === 0 && passed === assertions.length;
process.stdout.write(JSON.stringify({ success, numPassedTests: passed, numFailedTests: failures,
	testResults: [{ assertionResults: assertions }] }));
if (!success) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await namedCase();
