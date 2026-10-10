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

/** Only numeric timings for fixed installed-command phases may cross redaction. */
export function installedCommandMeasurements(messages: unknown) {
 if(!Array.isArray(messages))return undefined;
 const matches=messages.flatMap(message=>typeof message==='string'
  ? /^(?:Error: )?ACCEPTANCE_INSTALLED_PHASE_MEASUREMENTS: ([^\r\n]+)(?:\r?\n|$)/u.exec(message)?.[1]??[] : []);
 if(matches.length!==1||matches[0]!.length>4096)return undefined;
 try {
  const values:unknown=JSON.parse(matches[0]!);
  if(!Array.isArray(values)||values.length<1||values.length>16)return undefined;
  const phases=['PACK','INSTALL','DEPENDENCY_EXPORTS','PLAN','EXECUTE'];
  if(!values.every((value:unknown)=>{
   if(!value||typeof value!=='object'||Array.isArray(value))return false;
   const entry=value as Record<string,unknown>;
   return Object.keys(entry).sort().join(',')==='durationMs,phase,remainingMs'
    &&typeof entry.phase==='string'&&phases.includes(entry.phase)
    &&typeof entry.durationMs==='number'&&Number.isFinite(entry.durationMs)&&entry.durationMs>=0&&entry.durationMs<=1_200_000
    &&typeof entry.remainingMs==='number'&&Number.isFinite(entry.remainingMs)&&Math.abs(entry.remainingMs)<=1_200_000;
  }))return undefined;
  return values as {phase:string;durationMs:number;remainingMs:number}[];
 } catch {return undefined;}
}
