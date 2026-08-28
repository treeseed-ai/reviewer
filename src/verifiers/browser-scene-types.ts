import type { BrowserContext, Locator, Page } from 'playwright-core';

export type SceneSelector = {
  role?: string;
  name?: string;
  css?: string;
  scene?: string;
  testId?: string;
  internal?: boolean;
};

export type SceneDocument = {
  id: string;
  title?: string;
  journey?: { producesState?: Array<{ key?: string }> };
  setup?: { auth?: { required?: boolean; role?: string } };
  workflow?: SceneStep[];
};

export type SceneStep = {
  id: string;
  title?: string;
  action?: Record<string, unknown>;
  expect?: Record<string, unknown>;
};

export type SceneCase = {
  executionKey: string;
  scenePath: string;
  scene: SceneDocument;
  guaranteeIds: string[];
  dependsOn: string[];
};

export type SceneRuntime = {
  adminOrigin: string;
  apiOrigin: string;
  mailpitOrigin: string;
  runId: string;
  runShort: string;
  deviceId: string;
  evidenceRoot: string;
  page: Page;
  context: BrowserContext;
  consoleErrors: string[];
  requestErrors: string[];
};

export type SceneCheck = {
  id: string;
  status: 'passed' | 'failed' | 'blocked';
  durationMs: number;
  error?: string;
  evidence?: string[];
};

export type LocatorLike = Pick<Locator, 'click' | 'count' | 'evaluate' | 'fill' | 'first' | 'isVisible' | 'selectOption' | 'waitFor'>;
