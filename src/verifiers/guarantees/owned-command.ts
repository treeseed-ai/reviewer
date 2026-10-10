import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from 'node:child_process';
import { performance } from 'node:perf_hooks';

/** Keep native suite/verifier descendants within the command's own group.
 * Residue is failed evidence even when the original command returned zero. */
export function runOwnedCommand(command: string, args: readonly string[], options: SpawnSyncOptionsWithStringEncoding) {
  if (process.platform === 'win32') throw new Error('Native verifier process-group custody is unavailable on this host.');
  if (!Number.isSafeInteger(options.timeout) || Number(options.timeout) < 1)
    throw new Error('An original positive native command timeout is required.');
  const deadline = performance.now() + Number(options.timeout ?? 0);
  const execution = { ...options, detached: true, killSignal: 'SIGKILL' as const };
  const result = spawnSync(command, args, execution);
  if (!result.pid) return result;
  const fail = (message: string, code: string) => {
    const error = Object.assign(new Error(message), { code });
    // Cleanup cannot replace the original native failure. Retain every cleanup
    // observation in the aggregate while preserving the first failure's code.
    const original = result.error;
    result.error = original ? Object.assign(new AggregateError([
      ...(original instanceof AggregateError ? original.errors : [original]), error], message),
      { code: (original as NodeJS.ErrnoException).code ?? code }) : error;
  };
  const present = () => {
    try { process.kill(-result.pid, 0); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
  };
  try {
    if (!present()) return result;
    // Native runners may finish reaping their workers immediately after the leader.
    // Join that bounded termination under the original timeout before declaring residue.
    const wait = new Int32Array(new SharedArrayBuffer(4));
    const terminationDeadline = Math.min(deadline, performance.now() + 100);
    while (present() && performance.now() < terminationDeadline) Atomics.wait(wait, 0, 0, 10);
    if (!present()) return result;
    fail('Native command left owned descendants after termination.', 'VERIFIER_SUBPROCESS_RESIDUE');
    process.kill(-result.pid, 'SIGKILL');
    // Closure consumes only time remaining under the original command bound.
    const closureDeadline = Math.min(deadline, performance.now() + 1_000);
    while (present() && performance.now() < closureDeadline) Atomics.wait(wait, 0, 0, 10);
    if (present()) fail('Owned native command descendant closure is unproven.', 'VERIFIER_SUBPROCESS_CLOSURE_UNPROVEN');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
      fail('Owned native command process-group inspection or closure failed.', 'VERIFIER_SUBPROCESS_CLOSURE_UNPROVEN');
  }
  return result;
}
