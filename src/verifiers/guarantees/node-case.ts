import { run } from 'node:test';

// Normalize Node's named terminal events, never test stdout or secret payloads.
const [file, name] = process.argv.slice(2);
if (!file || !name) throw new Error('An exact test file and name are required.');
const pattern = `^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;
const assertions: Array<{ title: string; status: string; duration: number }> = [];
let failures = 0;
for await (const event of run({ files: [file], testNamePatterns: [pattern], execArgv: ['--import', 'tsx'] })) {
	if (event.type === 'test:fail') failures++;
	if ((event.type === 'test:pass' || event.type === 'test:fail') && event.data.name === name) {
		assertions.push({ title: name, status: event.data.skip ? 'skipped' : event.type === 'test:pass' ? 'passed' : 'failed',
			duration: event.data.details.duration_ms });
	}
}
const passed = assertions.filter(assertion => assertion.status === 'passed').length;
const success = passed > 0 && failures === 0 && passed === assertions.length;
process.stdout.write(JSON.stringify({ success, numPassedTests: passed, numFailedTests: failures,
	testResults: [{ assertionResults: assertions }] }));
if (!success) process.exitCode = 1;
