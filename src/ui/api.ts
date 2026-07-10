import type {
  ReviewerCommandResult,
  ReviewerCreateWorkplanRequest,
  ReviewerDraftNote,
  ReviewerGuaranteeCatalogEntry,
  ReviewerGuaranteePlanRequest,
  ReviewerGuaranteeReviewRun,
  ReviewerGuaranteeRunRequest,
  ReviewerGuaranteeRunSummary,
  ReviewerTask,
  ReviewerWorkspaceResponse,
  ReviewerWorkplanCreateResponse,
} from '../shared/contracts.ts';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(options?.headers ?? {}),
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error ?? `Request failed: ${response.status}`);
  return payload as T;
}

export const api = {
  workspace: () => request<ReviewerWorkspaceResponse>('/api/workspace'),
  runs: async () => (await request<{ runs: ReviewerGuaranteeRunSummary[] }>('/api/guarantee-runs')).runs,
  catalog: async () => (await request<{ guarantees: ReviewerGuaranteeCatalogEntry[] }>('/api/guarantee-catalog')).guarantees,
  plan: (body: ReviewerGuaranteePlanRequest) => request<ReviewerCommandResult>('/api/guarantee-runs/plan', { method: 'POST', body: JSON.stringify(body) }),
  run: (body: ReviewerGuaranteeRunRequest) => request<{ task: ReviewerTask }>('/api/guarantee-runs/run', { method: 'POST', body: JSON.stringify(body) }),
  task: (id: string) => request<{ task: ReviewerTask }>(`/api/tasks/${encodeURIComponent(id)}`),
  reviewRun: (runId: string) => request<ReviewerGuaranteeReviewRun>(`/api/guarantee-runs/${encodeURIComponent(runId)}`),
  evidenceText: (path: string, startLine = 0, lineCount = 400) => request<{ path: string; startLine: number; lineCount: number; totalLines: number; text: string }>(`/api/evidence/text?path=${encodeURIComponent(path)}&startLine=${startLine}&lineCount=${lineCount}`),
  draft: (runId: string, guaranteeId: string) => request<{ draft: ReviewerDraftNote | null }>(`/api/review-notes/${encodeURIComponent(runId)}/${encodeURIComponent(guaranteeId)}`),
  saveDraft: (draft: ReviewerDraftNote) => request<{ draft: ReviewerDraftNote }>(`/api/review-notes/${encodeURIComponent(draft.runId)}/${encodeURIComponent(draft.guaranteeId)}`, { method: 'PUT', body: JSON.stringify(draft) }),
  createWorkplan: (body: ReviewerCreateWorkplanRequest) => request<ReviewerWorkplanCreateResponse>('/api/workplans', { method: 'POST', body: JSON.stringify(body) }),
};

export function evidenceUrl(path: string) {
  return `/api/evidence?path=${encodeURIComponent(path)}`;
}
