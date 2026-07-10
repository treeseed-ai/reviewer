import { useState } from 'react';
import type { ReviewerGuaranteeReviewRun } from '../../shared/contracts.ts';
import { api } from '../api.ts';

export function WorkplanSummary({ run, included }: { run: ReviewerGuaranteeReviewRun; included: Set<string> }) {
  const [title, setTitle] = useState(`Guarantee fixes for ${run.run.runId}`);
  const [result, setResult] = useState<string | null>(null);
  const selected = run.items.filter((item) => included.has(item.guaranteeId));
  const byOwner = selected.reduce<Record<string, number>>((acc, item) => {
    acc[item.ownerPackage] = (acc[item.ownerPackage] ?? 0) + 1;
    return acc;
  }, {});
  const totalBytes = selected.flatMap((item) => item.evidence).reduce((sum, item) => sum + (item.byteSize ?? 0), 0);
  const packageWorkplan = async () => {
    const response = await api.createWorkplan({
      runId: run.run.runId,
      title,
      includeGuaranteeIds: selected.map((item) => item.guaranteeId),
      copyRawEvidence: true,
    });
    setResult(`${response.workplanRoot} (${response.directiveCount} directives, ${response.evidenceCount} evidence entries)`);
  };
  return (
    <div className="workplan-summary panel">
      <div className="panel-header"><h2>Package Workplan</h2><span>{selected.length} selected</span></div>
      <label>Title<input value={title} onChange={(event) => setTitle(event.target.value)} /></label>
      <div className="summary-grid">
        <span>Evidence size</span><strong>{Math.round(totalBytes / 1024)} KB</strong>
        <span>Owners</span><strong>{Object.entries(byOwner).map(([owner, count]) => `${owner} (${count})`).join(', ') || 'none'}</strong>
      </div>
      <button className="primary" disabled={!selected.length || !title.trim()} onClick={() => void packageWorkplan()}>Create Workplan Package</button>
      {result ? <div className="saved">{result}</div> : null}
    </div>
  );
}
