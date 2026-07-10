import type { ReviewerGuaranteeReviewItem } from '../../shared/contracts.ts';

export function WizardNav({ item, count, onPrev, onNext, onFinish, onBack, included }: {
  item: ReviewerGuaranteeReviewItem;
  count: number;
  onPrev: () => void;
  onNext: () => void;
  onFinish: () => void;
  onBack: () => void;
  included: boolean;
}) {
  return (
    <div className="wizard-nav">
      <button onClick={onBack}>Runs</button>
      <div className="wizard-title">
        <span>{item.index + 1} / {count}</span>
        <strong>{item.guaranteeId}</strong>
        <small>{item.ownerPackage} / {item.type}.{item.subtype}</small>
      </div>
      <div className="nav-actions">
        <span className={`status ${item.status}`}>{item.status}</span>
        {item.releaseBlocking ? <span className="status failed">release</span> : null}
        {included ? <span className="status passed">in workplan</span> : null}
        <button onClick={onPrev}>Prev</button>
        <button onClick={onNext}>Next</button>
        <button className="primary" onClick={onFinish}>Package</button>
      </div>
    </div>
  );
}
