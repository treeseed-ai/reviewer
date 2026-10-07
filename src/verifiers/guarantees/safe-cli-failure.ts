/** Retain an existing controlled criterion, never its assertion values or stack. */
export function failureCriterion(message: string): string | undefined {
	return /^(?:(?:AssertionError|Error): )?(ACCEPTANCE_[A-Z0-9_]+):/u.exec(message)?.[1];
}

/** Only the known command family and bounded error code may enter immutable evidence. */
export function safeCliFailure(message: string): string | null {
	const match = /^ACCEPTANCE_CLI_COMMAND: ([a-z][a-z0-9-]*)(?:\.([a-z][a-z0-9-]{0,79}))? ([A-Za-z][A-Za-z0-9_-]{0,79})$/u.exec(message);
	if (!match) return null;
	const [, family, action, code] = match;
	if (!family || !code || !['workdays', 'send', 'proposals', 'assignments', 'library', 'providers', 'capacity', 'dev'].includes(family)) return null;
	if (family !== 'send' && !action) return null;
	return `${family === 'send' ? 'send' : `${family}.${action}`} ${code}`;
}

/** Selected Vitest evidence uses the existing bounded failure shape, not raw report payloads. */
export function selectedVitestFailure(messages: unknown, file: string, absoluteFile: string) {
	const strings = Array.isArray(messages) ? messages.filter((message): message is string => typeof message === 'string') : [];
	const first = strings[0]?.split('\n')[0] ?? '';
	const code = /^(AssertionError|Error|TypeError|SyntaxError|ReferenceError|RangeError|TimeoutError):/u.exec(first)?.[1] ?? 'test_failed';
	const criterion = failureCriterion(first);
	const cliFailure = safeCliFailure(first.replace(/^(?:AssertionError|Error): /u, ''));
	const escape = (path: string) => path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const frame = new RegExp(`^\\s*(?:❯ |at (?:[^()\\r\\n]+ \\()?)` +
		`(?:file://)?(?:${escape(file)}|${escape(absoluteFile)}):(\\d+):(\\d+)\\)?\\s*$`, 'u');
	let line = 0, column = 0;
	for (const message of strings) for (const entry of message.split('\n')) {
		const match = frame.exec(entry), candidateLine = Number(match?.[1]), candidateColumn = Number(match?.[2]);
		if (!line && Number.isSafeInteger(candidateLine) && candidateLine > 0 && Number.isSafeInteger(candidateColumn) && candidateColumn > 0) {
			line = candidateLine; column = candidateColumn;
		}
	}
	return { code, file, line, column, ...(criterion ? { criterion } : {}), ...(cliFailure ? { cliFailure } : {}) };
}
