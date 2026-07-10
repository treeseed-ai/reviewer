import { useEffect, useMemo, useState } from 'react';
import { RunSelector } from './routes/RunSelector.tsx';
import { ReviewWizard } from './routes/ReviewWizard.tsx';
import { api } from './api.ts';
import type { ReviewerWorkspaceResponse } from '../shared/contracts.ts';

function currentRoute() {
  const match = window.location.pathname.match(/^\/runs\/(.+)\/review$/u);
  return match ? { screen: 'review' as const, runId: decodeURIComponent(match[1]!) } : { screen: 'runs' as const };
}

export function App() {
  const [route, setRoute] = useState(currentRoute);
  const [workspace, setWorkspace] = useState<ReviewerWorkspaceResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.workspace().then(setWorkspace).catch((err) => setError(err.message));
    const onPop = () => setRoute(currentRoute());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const nav = useMemo(() => ({
    openRun: (runId: string) => {
      const path = `/runs/${encodeURIComponent(runId)}/review`;
      window.history.pushState({}, '', path);
      setRoute({ screen: 'review', runId });
    },
    home: () => {
      window.history.pushState({}, '', '/');
      setRoute({ screen: 'runs' });
    },
  }), []);

  return (
    <div className="app-shell">
      <header className="top-strip">
        <div>
          <div className="eyebrow">Local-only</div>
          <h1>Guarantee Reviewer</h1>
        </div>
        <div className="workspace-chip">{workspace?.workspaceRoot ?? 'Loading workspace...'}</div>
      </header>
      {error ? <div className="error-banner">{error}</div> : null}
      {route.screen === 'review'
        ? <ReviewWizard runId={route.runId} onBack={nav.home} />
        : <RunSelector onOpenRun={nav.openRun} />}
    </div>
  );
}
