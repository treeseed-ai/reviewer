import { useEffect, useState } from 'react';
import type { ReviewerCommandResult, ReviewerGuaranteeCatalogEntry, ReviewerGuaranteeRunRequest, ReviewerGuaranteeRunSummary, ReviewerTask } from '../../shared/contracts.ts';
import { api } from '../api.ts';
import { RunFilterBuilder, defaultRunRequest } from '../components/RunFilterBuilder.tsx';
import { RunList } from '../components/RunList.tsx';

export function RunSelector({ onOpenRun }: { onOpenRun: (runId: string) => void }) {
  const [runs, setRuns] = useState<ReviewerGuaranteeRunSummary[]>([]);
  const [catalog, setCatalog] = useState<ReviewerGuaranteeCatalogEntry[]>([]);
  const [request, setRequest] = useState<ReviewerGuaranteeRunRequest>(defaultRunRequest);
  const [plan, setPlan] = useState<ReviewerCommandResult | null>(null);
  const [task, setTask] = useState<ReviewerTask | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => api.runs().then(setRuns).catch((err) => setError(err.message));
  useEffect(() => {
    refresh();
    api.catalog().then(setCatalog).catch((err) => setError(err.message));
  }, []);
  useEffect(() => {
    if (!task || task.status !== 'running') return;
    const events = new EventSource(`/api/tasks/${encodeURIComponent(task.id)}/events`);
    events.onmessage = (event) => {
      const payload = JSON.parse(event.data) as { task: ReviewerTask };
      setTask(payload.task);
      if (payload.task.status !== 'running') {
        events.close();
        refresh();
      }
    };
    events.onerror = () => {
      events.close();
      void api.task(task.id).then((next) => {
        setTask(next.task);
        if (next.task.status !== 'running') refresh();
      }).catch((err) => setError(err.message));
    };
    return () => events.close();
  }, [task?.id, task?.status]);

  async function planRun() {
    setError(null);
    setPlan(await api.plan(request));
  }

  async function runGuarantees() {
    setError(null);
    const started = await api.run(request);
    setTask(started.task);
  }

  return (
    <main className="run-selector">
      <section className="selector-grid">
        <RunFilterBuilder catalog={catalog} value={request} onChange={setRequest} onPlan={() => void planRun().catch((err) => setError(err.message))} onRun={() => void runGuarantees().catch((err) => setError(err.message))} busy={task?.status === 'running'} />
        <div className="panel command-panel">
          <div className="panel-header"><h2>Plan / Run Output</h2><span>{task?.status ?? 'idle'}</span></div>
          {error ? <div className="error-banner">{error}</div> : null}
          <pre>{task ? (task.output?.join('') || [...task.stdout, ...task.stderr].join('') || 'Guarantee task started; waiting for first output...') : plan ? JSON.stringify(plan.report ?? plan, null, 2) : 'Plan a focused guarantee run or start execution.'}</pre>
          {task?.run ? <button className="primary" onClick={() => onOpenRun(task.run!.runId)}>Open Generated Run</button> : null}
        </div>
      </section>
      <RunList runs={runs} onOpenRun={onOpenRun} />
    </main>
  );
}
