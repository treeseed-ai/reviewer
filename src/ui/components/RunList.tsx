import type { ReviewerGuaranteeRunSummary } from '../../shared/contracts.ts';

function filterSummary(run: ReviewerGuaranteeRunSummary) {
  const entries = Object.entries(run.filter ?? {}).filter(([, value]) => Array.isArray(value) ? value.length > 0 : Boolean(value));
  return entries.length ? entries.map(([key, value]) => `${key}=${Array.isArray(value) ? value.join(',') : value}`).join(' ') : 'all active guarantees';
}

export function RunList({ runs, onOpenRun }: { runs: ReviewerGuaranteeRunSummary[]; onOpenRun: (runId: string) => void }) {
  return (
    <div className="panel run-list">
      <div className="panel-header">
        <h2>Existing Runs</h2>
        <span>{runs.length} discovered</span>
      </div>
      <div className="run-table">
        <div className="run-row run-head">
          <span>Run</span><span>Env</span><span>Filter</span><span>Result</span><span></span>
        </div>
        {runs.map((run) => (
          <div className="run-row" key={`${run.kind}:${run.runId}`}>
            <span>
              <strong>{run.runId}</strong>
              <small>{run.kind} / {new Date(run.startedAt).toLocaleString()}</small>
            </span>
            <span>{run.environment}</span>
            <span className="muted">{filterSummary(run)}</span>
            <span className={`status ${run.ok ? 'passed' : 'failed'}`}>
              {run.counts.passed} pass / {run.counts.failed} fail / {run.counts.blocked} blocked
              {run.counts.releaseBlockingFailures ? <small>{run.counts.releaseBlockingFailures} release blockers</small> : null}
            </span>
            <button onClick={() => onOpenRun(run.runId)}>Open</button>
          </div>
        ))}
        {runs.length === 0 ? <div className="empty">No local guarantee runs found yet.</div> : null}
      </div>
    </div>
  );
}
