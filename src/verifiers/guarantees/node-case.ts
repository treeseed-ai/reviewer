import { run } from 'node:test';
import { createRequire } from 'node:module';
import { safeCliFailure } from './safe-cli-failure.ts';

// Normalize Node's named terminal events, never test stdout or secret payloads.
const [file, name] = process.argv.slice(2);
if (!file || !name) throw new Error('An exact test file and name are required.');
const pattern = `^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;
const assertions: Array<{ title: string; status: string; duration: number; failure?: { code: string; file: string; line: number; column: number; criterion?: string; cliFailure?: string } }> = [];
let failures = 0;
const loader = createRequire(import.meta.url).resolve('tsx');
for await (const event of run({ files: [file], testNamePatterns: [pattern], execArgv: ['--import', loader] })) {
	if (event.type === 'test:fail') failures++;
	if ((event.type === 'test:pass' || event.type === 'test:fail') && event.data.name === name) {
		const error = event.type === 'test:fail' ? event.data.details.error : undefined;
		const cause = error?.cause as Error | undefined;
		const message = String(cause?.message ?? error?.message ?? '');
		const criterion = /^ACCEPTANCE_[A-Z0-9_]+(?=:)/u.exec(message)?.[0];
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
