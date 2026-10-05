import type {
  GuaranteeDiagnostic,
  GuaranteeFilter,
  GuaranteePlanReport,
  GuaranteeRunReport,
  GuaranteeRunResult,
  GuaranteeRunStatus,
  GuaranteeRunStep,
} from '@treeseed/sdk/guarantees';

export type ReviewerRunKind = 'local' | 'release';
export type ReviewerDirectiveClassification =
  | 'product-defect'
  | 'ui-defect'
  | 'test-defect'
  | 'fixture-environment-defect'
  | 'missing-implementation'
  | 'weak-guarantee'
  | 'ux-improvement'
  | 'architecture-issue'
  | 'security-safety-issue'
  | 'investigate';

export type ReviewerDirectivePriority = 'release-blocking' | 'high' | 'medium' | 'low';
export type ReviewerDirectiveType = 'fix' | 'improvement' | 'test-repair' | 'guarantee-repair' | 'fixture-repair' | 'investigation';
export type ReviewerEvidenceKind = 'screenshot' | 'log' | 'trace' | 'video' | 'json' | 'markdown' | 'csv' | 'manifest' | 'unknown';

export type ReviewerWorkspaceResponse = {
  workspaceRoot: string;
  reviewerVersion: string;
  packageName: '@treeseed/reviewer';
};

export type ReviewerGuaranteeRunSummary = {
  runId: string;
  kind: ReviewerRunKind;
  outputRoot: string;
  reportPath: string;
  planPath?: string;
  markdownPath?: string;
  generatedCsvPath?: string;
  environment: string;
  startedAt: string;
  completedAt?: string;
  ok: boolean;
  filter: GuaranteeFilter;
  counts: {
    passed: number;
    failed: number;
    skipped: number;
    blocked: number;
    releaseBlockingFailures: number;
  };
};

export type ReviewerGuaranteeCatalogEntry = {
  id: string;
  journey: string;
  ownerPackage: string;
  type: string;
  subtype: string;
  status: string;
  gates: string[];
  sourcePath: string;
  label: string;
};

export type ReviewerGuaranteePlanRequest = {
  environment: 'local' | 'staging' | 'prod';
  filter: GuaranteeFilter;
  includeDependencies: boolean;
  includePlanned: boolean;
  device?: string;
};

export type ReviewerGuaranteeRunRequest = ReviewerGuaranteePlanRequest & {
  record: boolean;
  sceneArtifacts: 'screenshots' | 'full';
  evidenceTarget: 'local' | 'release';
};

export type ReviewerCommandResult = {
  ok: boolean;
  exitCode: number | null;
  command: string[];
  stdout: string;
  stderr: string;
  report?: unknown;
};

export type ReviewerTaskStatus = 'running' | 'completed' | 'failed';

export type ReviewerTask = {
  id: string;
  status: ReviewerTaskStatus;
  command: string[];
  startedAt: string;
  completedAt?: string;
  stdout: string[];
  stderr: string[];
  output: string[];
  lastOutputAt: string;
  result?: ReviewerCommandResult;
  run?: ReviewerGuaranteeRunSummary;
};

export type ReviewerEvidenceItem = {
  id: string;
  kind: ReviewerEvidenceKind;
  path: string;
  absolutePath: string;
  exists: boolean;
  source: 'result' | 'step' | 'context';
  stepId?: string;
  label: string;
  byteSize?: number;
  contentHash?: string;
  duplicateOf?: string;
  duplicateCount?: number;
  runDuplicateEvidenceCount?: number;
  runDuplicateGuaranteeCount?: number;
};

export type ReviewerGuaranteeReviewItem = {
  id: string;
  index: number;
  guaranteeId: string;
  journey: string;
  ownerPackage: string;
  type: string;
  subtype: string;
  status: GuaranteeRunStatus;
  selected: boolean;
  dependency: boolean;
  releaseBlocking: boolean;
  sourcePath: string;
  summary: string;
  steps: GuaranteeRunStep[];
  diagnostics: GuaranteeDiagnostic[];
  evidence: ReviewerEvidenceItem[];
  primaryScreenshot?: ReviewerEvidenceItem;
  primaryLog?: ReviewerEvidenceItem;
  recommendedClassification: ReviewerDirectiveClassification;
  recommendedPriority: ReviewerDirectivePriority;
  rerunCommand: string;
};

export type ReviewerGuaranteeReviewRun = {
  run: ReviewerGuaranteeRunSummary;
  report: GuaranteeRunReport;
  plan: GuaranteePlanReport | null;
  items: ReviewerGuaranteeReviewItem[];
};

export type ReviewerDraftNote = {
  schemaVersion: 'treeseed.reviewer.draft-note/v1';
  runId: string;
  guaranteeId: string;
  updatedAt: string;
  classification: ReviewerDirectiveClassification;
  priority: ReviewerDirectivePriority;
  ownerPackage: string;
  note: string;
  expectedBehavior?: string;
  selectedEvidenceIds: string[];
  includeInWorkplan: boolean;
};

export type ReviewerCreateWorkplanRequest = {
  runId: string;
  title: string;
  scopeSummary?: string;
  includeGuaranteeIds: string[];
  copyRawEvidence: true;
};

export type ReviewerWorkplanCreateResponse = {
  workplanId: string;
  workplanRoot: string;
  workplanYamlPath: string;
  workplanMarkdownPath: string;
  agentBriefPath: string;
  directiveCount: number;
  evidenceCount: number;
};

export type ReviewerCopiedEvidence = {
  id: string;
  directiveId: string;
  guaranteeId: string;
  kind: ReviewerEvidenceKind;
  sourcePath: string;
  copiedPath?: string;
  exists: boolean;
  sha256?: string;
  byteSize?: number;
  sensitivity: 'local-private' | 'unknown';
};

export type ReviewerDirectiveSummary = {
  id: string;
  order: number;
  guaranteeId: string;
  ownerPackage: string;
  type: ReviewerDirectiveType;
  priority: ReviewerDirectivePriority;
  classification: ReviewerDirectiveClassification;
  markdownPath: string;
  yamlPath: string;
};

export type ReviewerWorkplan = {
  schemaVersion: 'treeseed.reviewer.workplan/v1';
  id: string;
  title: string;
  createdAt: string;
  workspaceRoot: string;
  source: {
    runId: string;
    runOutputRoot: string;
    reportPath: string;
    environment: string;
    filter: GuaranteeFilter;
  };
  summary: {
    directiveCount: number;
    releaseBlockingDirectiveCount: number;
    ownerPackages: string[];
    statuses: Record<string, number>;
  };
  directives: ReviewerDirectiveSummary[];
  evidenceManifest: string;
  commands: {
    reproduce: string;
    verify: string;
  };
};

export type ReviewerDirective = {
  schemaVersion: 'treeseed.reviewer.directive/v1';
  id: string;
  order: number;
  type: ReviewerDirectiveType;
  priority: ReviewerDirectivePriority;
  source: {
    runId: string;
    guaranteeId: string;
    ownerPackage: string;
    type: string;
    subtype: string;
    journey: string;
    status: GuaranteeRunStatus;
    sourcePath: string;
    verifierRefs: string[];
    sceneRefs: string[];
    failedStepIds: string[];
  };
  reviewer: {
    note: string;
    expectedBehavior?: string;
    classification: ReviewerDirectiveClassification;
  };
  evidence: {
    copied: ReviewerCopiedEvidence[];
    sourcePaths: string[];
    diagnostics: GuaranteeDiagnostic[];
  };
  constraints: string[];
  acceptance: {
    rerunCommands: string[];
    requiredOutcome: string[];
  };
};

export type ReviewerRunPaths = {
  runId: string;
  kind: ReviewerRunKind;
  outputRoot: string;
  reportPath: string;
  planPath: string;
  markdownPath: string;
  generatedCsvPath: string;
};

export type ReviewerRunWithPaths = {
  summary: ReviewerGuaranteeRunSummary;
  paths: ReviewerRunPaths;
  report: GuaranteeRunReport;
  plan: GuaranteePlanReport | null;
  results: GuaranteeRunResult[];
};
