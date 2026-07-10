import { useEffect, useMemo, useState } from 'react';
import type { ReviewerGuaranteeReviewRun } from '../../shared/contracts.ts';
import { api } from '../api.ts';
import { EvidenceViewer } from '../components/EvidenceViewer.tsx';
import { LogViewer } from '../components/LogViewer.tsx';
import { NotesComposer } from '../components/NotesComposer.tsx';
import { WizardNav } from '../components/WizardNav.tsx';
import { WorkplanSummary } from '../components/WorkplanSummary.tsx';

export function ReviewWizard({ runId, onBack }: { runId: string; onBack: () => void }) {
  const [run, setRun] = useState<ReviewerGuaranteeReviewRun | null>(null);
  const [index, setIndex] = useState(0);
  const [included, setIncluded] = useState<Set<string>>(new Set());
  const [showPackage, setShowPackage] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.reviewRun(runId).then(setRun).catch((err) => setError(err.message));
  }, [runId]);

  const item = run?.items[index];
  const count = run?.items.length ?? 0;
  const move = (delta: number) => setIndex((current) => Math.min(Math.max(0, current + delta), Math.max(0, count - 1)));

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement) return;
      if (event.key === 'j' || event.key === 'ArrowRight') move(1);
      if (event.key === 'k' || event.key === 'ArrowLeft') move(-1);
      if (event.key === 'f') document.getElementById('reviewer-note')?.focus();
      if (event.key === 'p') setShowPackage(true);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [count]);

  const includeCurrent = (include: boolean) => {
    if (!item) return;
    setIncluded((prev) => {
      const next = new Set(prev);
      if (include) next.add(item.guaranteeId);
      else next.delete(item.guaranteeId);
      return next;
    });
  };

  const ownerCounts = useMemo(() => {
    return run?.items.reduce<Record<string, number>>((acc, entry) => {
      acc[entry.ownerPackage] = (acc[entry.ownerPackage] ?? 0) + 1;
      return acc;
    }, {}) ?? {};
  }, [run]);

  if (error) return <div className="error-banner">{error}</div>;
  if (!run || !item) return <main className="loading">Loading guarantee run...</main>;

  return (
    <main className="review-screen">
      <WizardNav item={item} count={count} onPrev={() => move(-1)} onNext={() => move(1)} onFinish={() => setShowPackage(true)} onBack={onBack} included={included.has(item.guaranteeId)} />
      <div className="review-meta">
        {Object.entries(ownerCounts).map(([owner, count]) => <span key={owner}>{owner}: {count}</span>)}
      </div>
      <section className="review-grid">
        <div className="left-stack">
          <div className="panel evidence-panel"><EvidenceViewer item={item} /></div>
          <div className="panel logs-panel"><LogViewer item={item} /></div>
        </div>
        <aside className="panel instruction-panel">
          <NotesComposer runId={run.run.runId} item={item} included={included.has(item.guaranteeId)} onIncluded={includeCurrent} />
        </aside>
      </section>
      {showPackage ? <WorkplanSummary run={run} included={included} /> : null}
    </main>
  );
}
