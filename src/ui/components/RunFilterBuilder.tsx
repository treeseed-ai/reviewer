import { useMemo, useState } from 'react';
import type { ReviewerGuaranteeCatalogEntry, ReviewerGuaranteeRunRequest } from '../../shared/contracts.ts';

const gates = ['', 'smoke', 'core', 'release', 'security', 'migration', 'demo'];
const statuses = ['active', 'planned', 'blocked', 'backlog', 'deprecated'];
const packages = ['', '@treeseed/market', '@treeseed/admin', '@treeseed/api', '@treeseed/agent', '@treeseed/core', '@treeseed/cli', '@treeseed/sdk', '@treeseed/ui', '@treeseed/reviewer'];

export function defaultRunRequest(): ReviewerGuaranteeRunRequest {
  return {
    environment: 'local',
    filter: {},
    includeDependencies: true,
    includePlanned: false,
    record: false,
    sceneArtifacts: 'screenshots',
    evidenceTarget: 'local',
  };
}

function commandPreview(value: ReviewerGuaranteeRunRequest) {
  const parts = ['npm', 'run', 'guarantees:run', '--', '--environment', value.environment];
  const filter = value.filter;
  if (filter.ownerPackage) parts.push('--guarantee-owner-package', filter.ownerPackage);
  if (filter.gate) parts.push('--gates', String(filter.gate));
  if (filter.status) parts.push('--statuses', String(filter.status));
  else if (value.includePlanned) parts.push('--statuses', 'active,planned');
  if (filter.type) parts.push('--types', filter.type);
  if (filter.subtype) parts.push('--subtypes', filter.subtype);
  if (filter.ids?.length) parts.push('--ids', filter.ids.join(','));
  if (!value.includeDependencies) parts.push('--no-dependencies');
  if (value.record) parts.push('--record');
  parts.push('--scene-artifacts', value.sceneArtifacts, '--evidence-target', value.evidenceTarget);
  return parts.join(' ');
}

export function RunFilterBuilder({ catalog, value, onChange, onPlan, onRun, busy }: {
  catalog: ReviewerGuaranteeCatalogEntry[];
  value: ReviewerGuaranteeRunRequest;
  onChange: (next: ReviewerGuaranteeRunRequest) => void;
  onPlan: () => void;
  onRun: () => void;
  busy?: boolean;
}) {
  const [query, setQuery] = useState('');
  const update = (patch: Partial<ReviewerGuaranteeRunRequest>) => onChange({ ...value, ...patch });
  const filteredCatalog = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return catalog.filter((entry) => !needle || `${entry.label} ${entry.id}`.toLowerCase().includes(needle)).slice(0, 40);
  }, [catalog, query]);
  const selectedId = value.filter.ids?.[0] ?? '';
  const selected = catalog.find((entry) => entry.id === selectedId);
  const applyPreset = (preset: 'full' | 'admin-active' | 'api-active') => {
    if (preset === 'full') onChange({ ...value, filter: {}, includeDependencies: true, includePlanned: false, sceneArtifacts: 'screenshots', device: undefined });
    if (preset === 'admin-active') onChange({ ...value, filter: { status: 'active', ownerPackage: '@treeseed/admin' }, includeDependencies: true, sceneArtifacts: 'screenshots', device: undefined });
    if (preset === 'api-active') onChange({ ...value, filter: { status: 'active', ownerPackage: '@treeseed/api' }, includeDependencies: true, sceneArtifacts: 'screenshots', device: undefined });
  };
  const selectGuarantee = (id: string) => {
    const entry = catalog.find((candidate) => candidate.id === id);
    if (!entry) return;
    onChange({
      ...value,
      filter: {
        status: entry.status as ReviewerGuaranteeRunRequest['filter']['status'],
        ids: [entry.id],
      },
      includeDependencies: true,
      includePlanned: entry.status !== 'active',
      sceneArtifacts: 'screenshots',
      device: undefined,
    });
  };
  const updateFilter = (key: string, nextValue: string) => {
    const filter = { ...value.filter };
    delete filter.ids;
    delete filter.journeyIndexes;
    if (nextValue) (filter as Record<string, unknown>)[key] = nextValue;
    else delete (filter as Record<string, unknown>)[key];
    onChange({ ...value, filter });
  };
  return (
    <div className="panel filter-builder">
      <div className="panel-header">
        <h2>Run Creator</h2>
        <span>choose the smallest useful scope</span>
      </div>
      <div className="help-block">
        <strong>Start narrow.</strong>
        <span>By default this runs the full active guarantee set. Use the guarantee picker or package/type filters only when you intentionally want a smaller diagnostic run.</span>
      </div>
      <div className="preset-row" aria-label="Common guarantee run presets">
        <button type="button" onClick={() => applyPreset('full')}>Full active run</button>
        <button type="button" onClick={() => applyPreset('admin-active')}>Admin active guarantees</button>
        <button type="button" onClick={() => applyPreset('api-active')}>API active guarantees</button>
      </div>
      <div className="form-section-title">Scope</div>
      <div className="guarantee-picker">
        <label>Find a guarantee by name<span className="field-help">Search by memorable journey text like "register user", "team invite", or "workplan"; no ids or journey numbers required.</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search guarantees by workflow name" /></label>
        <select value={selectedId} onChange={(event) => selectGuarantee(event.target.value)}>
          <option value="">No specific guarantee selected</option>
          {filteredCatalog.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
        </select>
        {selected ? <div className="selected-guarantee"><strong>{selected.journey}</strong><span>{selected.ownerPackage} / {selected.type}.{selected.subtype} / {selected.gates.join(', ')}</span></div> : null}
      </div>
      <div className="form-grid">
        <label>Environment<span className="field-help">Use local for UI repair work. Staging/prod require hosted credentials.</span><select value={value.environment} onChange={(e) => update({ environment: e.target.value as ReviewerGuaranteeRunRequest['environment'] })}><option>local</option><option>staging</option><option>prod</option></select></label>
        <label>Owner package<span className="field-help">Limits the run to guarantees owned by one package.</span><select value={value.filter.ownerPackage ?? ''} onChange={(e) => updateFilter('ownerPackage', e.target.value)}>{packages.map((entry) => <option key={entry} value={entry}>{entry || 'all packages'}</option>)}</select></label>
        <label>Gate<span className="field-help">Release/security gates are slower but more meaningful for ship readiness.</span><select value={value.filter.gate ?? ''} onChange={(e) => updateFilter('gate', e.target.value)}>{gates.map((entry) => <option key={entry} value={entry}>{entry || 'all gates'}</option>)}</select></label>
        <label>Status<span className="field-help">Active guarantees execute. Planned entries only appear when included.</span><select value={value.filter.status ?? ''} onChange={(e) => updateFilter('status', e.target.value)}>{statuses.map((entry) => <option key={entry}>{entry}</option>)}</select></label>
        <label>Type<span className="field-help">Broad product area, for example checkout, capacity, reviewer.</span><input value={value.filter.type ?? ''} onChange={(e) => updateFilter('type', e.target.value)} placeholder="reviewer" /></label>
        <label>Subtype<span className="field-help">Narrower capability inside the type, for example workplan.</span><input value={value.filter.subtype ?? ''} onChange={(e) => updateFilter('subtype', e.target.value)} placeholder="workplan" /></label>
      </div>
      <div className="toggle-row">
        <label><input type="checkbox" checked={value.includeDependencies} onChange={(e) => update({ includeDependencies: e.target.checked })} /> include dependencies <span>recommended</span></label>
        <label><input type="checkbox" checked={value.includePlanned} onChange={(e) => update({ includePlanned: e.target.checked })} /> include planned <span>skipped report rows</span></label>
      </div>
      <div className="command-preview">
        <span>Command preview</span>
        <code>{commandPreview(value)}</code>
      </div>
      <div className="action-row">
        <button disabled={busy} onClick={onPlan}>Plan Run</button>
        <button disabled={busy} className="primary" onClick={onRun}>Run Guarantees</button>
      </div>
    </div>
  );
}
