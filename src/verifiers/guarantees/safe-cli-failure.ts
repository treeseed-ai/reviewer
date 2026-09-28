/** Only the known command family and bounded error code may enter immutable evidence. */
export function safeCliFailure(message: string): string | null {
	const match = /^ACCEPTANCE_CLI_COMMAND: ([a-z][a-z0-9-]*)(?:\.([a-z][a-z0-9-]{0,79}))? ([A-Za-z][A-Za-z0-9_-]{0,79})$/u.exec(message);
	if (!match) return null;
	const [, family, action, code] = match;
	if (!family || !code || !['workdays', 'send', 'proposals', 'assignments', 'library', 'providers', 'capacity', 'dev'].includes(family)) return null;
	if (family !== 'send' && !action) return null;
	return `${family === 'send' ? 'send' : `${family}.${action}`} ${code}`;
}
