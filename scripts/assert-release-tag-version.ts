import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const packageJson = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as {
	name?: string;
	version?: string;
};
const tagName = process.argv[2] || process.env.GITHUB_REF_NAME;
const semverTagPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

if (!tagName || !semverTagPattern.test(tagName)) {
	console.error('Reviewer release requires a semantic version tag.');
	process.exit(1);
}
if (tagName !== packageJson.version) {
	console.error(`Release tag "${tagName}" does not match ${packageJson.name ?? 'Reviewer'} version "${packageJson.version}".`);
	process.exit(1);
}

console.log(`Release tag "${tagName}" matches ${packageJson.name ?? 'Reviewer'} version "${packageJson.version}".`);
