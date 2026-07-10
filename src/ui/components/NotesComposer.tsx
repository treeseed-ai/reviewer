import { useEffect, useState } from 'react';
import type { ReviewerDirectiveClassification, ReviewerDirectivePriority, ReviewerDraftNote, ReviewerGuaranteeReviewItem } from '../../shared/contracts.ts';
import { api } from '../api.ts';

const classifications: ReviewerDirectiveClassification[] = ['product-defect', 'ui-defect', 'test-defect', 'fixture-environment-defect', 'missing-implementation', 'weak-guarantee', 'ux-improvement', 'architecture-issue', 'security-safety-issue', 'investigate'];
const priorities: ReviewerDirectivePriority[] = ['release-blocking', 'high', 'medium', 'low'];

export function NotesComposer({ runId, item, included, onIncluded }: {
  runId: string;
  item: ReviewerGuaranteeReviewItem;
  included: boolean;
  onIncluded: (include: boolean) => void;
}) {
  const [note, setNote] = useState('');
  const [expected, setExpected] = useState('');
  const [classification, setClassification] = useState<ReviewerDirectiveClassification>(item.recommendedClassification);
  const [priority, setPriority] = useState<ReviewerDirectivePriority>(item.recommendedPriority);
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    setSaved(null);
    setNote('');
    setExpected('');
    setClassification(item.recommendedClassification);
    setPriority(item.recommendedPriority);
    api.draft(runId, item.guaranteeId).then(({ draft }) => {
      if (!draft) return;
      setNote(draft.note);
      setExpected(draft.expectedBehavior ?? '');
      setClassification(draft.classification);
      setPriority(draft.priority);
      onIncluded(draft.includeInWorkplan);
    }).catch(() => undefined);
  }, [runId, item.guaranteeId]);

  const save = async (includeInWorkplan: boolean) => {
    const draft: ReviewerDraftNote = {
      schemaVersion: 'treeseed.reviewer.draft-note/v1',
      runId,
      guaranteeId: item.guaranteeId,
      updatedAt: new Date().toISOString(),
      classification,
      priority,
      ownerPackage: item.ownerPackage,
      note: note || item.summary,
      ...(expected ? { expectedBehavior: expected } : {}),
      selectedEvidenceIds: item.evidence.map((entry) => entry.id),
      includeInWorkplan,
    };
    await api.saveDraft(draft);
    onIncluded(includeInWorkplan);
    setSaved(includeInWorkplan ? 'Added to workplan' : 'Marked not actionable');
  };

  return (
    <div className="notes-composer">
      <label>Classification<select value={classification} onChange={(event) => setClassification(event.target.value as ReviewerDirectiveClassification)}>{classifications.map((entry) => <option key={entry}>{entry}</option>)}</select></label>
      <label>Priority<select value={priority} onChange={(event) => setPriority(event.target.value as ReviewerDirectivePriority)}>{priorities.map((entry) => <option key={entry}>{entry}</option>)}</select></label>
      <label>What should the agent fix?<textarea id="reviewer-note" value={note} onChange={(event) => setNote(event.target.value)} placeholder="Describe the visible issue, intended behavior, and any implementation constraints." /></label>
      <label>Expected behavior<textarea value={expected} onChange={(event) => setExpected(event.target.value)} placeholder="The user should be able to..." /></label>
      <div className="evidence-summary">
        {item.evidence.length} evidence item(s), {item.diagnostics.length} diagnostic(s), rerun command included.
      </div>
      <div className="action-row">
        <button className="primary" onClick={() => void save(true)}>{included ? 'Update Workplan Item' : 'Add to Workplan'}</button>
        <button onClick={() => void save(false)}>Mark Not Actionable</button>
      </div>
      {saved ? <div className="saved">{saved}</div> : null}
    </div>
  );
}
