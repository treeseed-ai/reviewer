import type { ReviewerGuaranteeReviewItem } from '../../shared/contracts.ts';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.ts';

export function LogViewer({ item }: { item: ReviewerGuaranteeReviewItem }) {
  const primaryLog = useMemo(() => item.primaryLog ?? item.evidence.find((entry) => entry.kind === 'json' && entry.exists), [item]);
  const [logText, setLogText] = useState<string>('');
  const [logError, setLogError] = useState<string | null>(null);
  useEffect(() => {
    setLogText('');
    setLogError(null);
    if (!primaryLog) return;
    api.evidenceText(primaryLog.absolutePath, 0, 240)
      .then((payload) => {
        const trimmed = payload.text.trim();
        if (primaryLog.kind === 'json') {
          try {
            setLogText(JSON.stringify(JSON.parse(trimmed), null, 2));
            return;
          } catch {
            // Fall back to raw text.
          }
        }
        setLogText(trimmed);
      })
      .catch((error) => setLogError(error instanceof Error ? error.message : String(error)));
  }, [primaryLog?.absolutePath, primaryLog?.kind]);
  return (
    <div className="log-viewer">
      <div className="log-section">
        <h3>Diagnostics</h3>
        {item.diagnostics.length ? item.diagnostics.map((entry, index) => (
          <div className={`log-line ${entry.severity}`} key={`${entry.code}-${index}`}>
            <strong>{entry.code}</strong> {entry.message}
            {entry.sourcePath ? <small>{entry.sourcePath}</small> : null}
          </div>
        )) : <div className="muted">No diagnostics recorded.</div>}
      </div>
      <div className="log-section">
        <h3>Steps</h3>
        {item.steps.map((step) => (
          <div className={`step-line ${step.status}`} key={step.id}>
            <span>{step.kind}</span>
            <strong>{step.id}</strong>
            <em>{step.status}</em>
            <p>{step.summary ?? step.ref ?? ''}</p>
          </div>
        ))}
        {item.steps.length === 0 ? <div className="muted">No steps were recorded.</div> : null}
      </div>
      <div className="log-section">
        <h3>Primary Log</h3>
        {primaryLog ? <small>{primaryLog.path}</small> : <div className="muted">No log or JSON evidence file was recorded.</div>}
        {logError ? <div className="log-line error">{logError}</div> : null}
        {logText ? <pre className="log-preview">{logText}</pre> : null}
      </div>
    </div>
  );
}
