import { useEffect, useMemo, useState } from 'react';
import type { ReviewerGuaranteeReviewItem } from '../../shared/contracts.ts';
import { evidenceUrl } from '../api.ts';

export function EvidenceViewer({ item }: { item: ReviewerGuaranteeReviewItem }) {
  const allImages = item.evidence.filter((entry) => entry.kind === 'screenshot' && entry.exists);
  const images = allImages.filter((entry) => !entry.duplicateOf);
  const duplicateImageCount = allImages.length - images.length;
  const [selectedId, setSelectedId] = useState<string | null>(item.primaryScreenshot?.id ?? images[0]?.id ?? null);
  useEffect(() => {
    setSelectedId(item.primaryScreenshot?.id ?? images[0]?.id ?? null);
  }, [item.guaranteeId]);
  const selected = useMemo(() => images.find((entry) => entry.id === selectedId) ?? item.primaryScreenshot ?? images[0], [item.primaryScreenshot, selectedId, images]);
  const selectedIndex = selected ? images.findIndex((image) => image.id === selected.id) : -1;
  const selectOffset = (offset: number) => {
    if (selectedIndex < 0 || images.length === 0) return;
    const nextIndex = (selectedIndex + offset + images.length) % images.length;
    setSelectedId(images[nextIndex]?.id ?? null);
  };
  if (selected?.kind === 'screenshot') {
    return (
      <div className="evidence-viewer">
        <div className="screenshot-toolbar">
          <strong>{selected.label}</strong>
          <span>{selectedIndex + 1} / {images.length} unique</span>
          {selected.duplicateCount ? <span>{selected.duplicateCount} duplicate{selected.duplicateCount === 1 ? '' : 's'}</span> : null}
          {duplicateImageCount ? <span>{duplicateImageCount} duplicate{duplicateImageCount === 1 ? '' : 's'} collapsed</span> : null}
          {selected.runDuplicateGuaranteeCount && selected.runDuplicateGuaranteeCount > 1
            ? <span>same capture in {selected.runDuplicateGuaranteeCount} guarantees</span>
            : null}
          <a href={evidenceUrl(selected.absolutePath)} target="_blank" rel="noreferrer">Open</a>
        </div>
        <div className="screenshot-frame" aria-label={`Screenshot ${selectedIndex + 1} of ${images.length}`}>
          <button className="screenshot-step previous" type="button" onClick={() => selectOffset(-1)} aria-label="Previous screenshot">Prev</button>
          <img src={evidenceUrl(selected.absolutePath)} alt={selected.label} />
          <button className="screenshot-step next" type="button" onClick={() => selectOffset(1)} aria-label="Next screenshot">Next</button>
        </div>
        <div className="thumb-strip" aria-label="Screenshot thumbnails">
          {images.map((image, index) => (
            <button
              key={image.id}
              className={image.id === selected.id ? 'active' : ''}
              type="button"
              aria-pressed={image.id === selected.id}
              aria-label={`Select screenshot ${index + 1}: ${image.label}`}
              onClick={() => setSelectedId(image.id)}
            >
              <img src={evidenceUrl(image.absolutePath)} alt="" />
              <span>{index + 1}</span>
            </button>
          ))}
        </div>
      </div>
    );
  }
  return (
    <div className="evidence-viewer no-image">
      <h3>{item.journey}</h3>
      <p>{item.summary}</p>
      <dl>
        <dt>Source</dt><dd>{item.sourcePath}</dd>
        <dt>Selected</dt><dd>{String(item.selected)}</dd>
        <dt>Dependency</dt><dd>{String(item.dependency)}</dd>
        <dt>Rerun</dt><dd><code>{item.rerunCommand}</code></dd>
      </dl>
      <div className="evidence-list">
        {item.evidence.map((entry) => (
          <a key={entry.id} href={evidenceUrl(entry.absolutePath)} target="_blank" rel="noreferrer">
            {entry.kind} / {entry.label}{entry.exists ? '' : ' (missing)'}
          </a>
        ))}
        {item.evidence.length === 0 ? <span>No attached evidence paths for this guarantee.</span> : null}
      </div>
    </div>
  );
}
