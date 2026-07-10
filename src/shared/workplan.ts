import type { ReviewerDirectiveClassification, ReviewerDirectiveType } from './contracts.ts';

export const REVIEWER_DIRECTIVE_CONSTRAINTS = [
  'Do not weaken or remove the guarantee unless classification is test-defect, weak-guarantee, or guarantee-repair.',
  'Preserve package ownership and standalone package verification.',
  'Use stable data-scene or testId selectors for UI workflow landmarks.',
  'Fix type and lint failures at the source.',
  'Verify with the focused rerun command before broad checks.',
];

export function directiveTypeFor(classification: ReviewerDirectiveClassification): ReviewerDirectiveType {
  if (classification === 'ux-improvement') return 'improvement';
  if (classification === 'test-defect') return 'test-repair';
  if (classification === 'weak-guarantee') return 'guarantee-repair';
  if (classification === 'fixture-environment-defect') return 'fixture-repair';
  if (classification === 'investigate') return 'investigation';
  return 'fix';
}
