import { describe, expect, it } from 'vitest';
import {
  acknowledgedEntities,
  addedLines,
  checkReintroduction,
  extractEntities,
  formatGuard,
  removedLines,
  type RevertedEntity,
} from './revert-guard.js';

/**
 * P2-GIT-01 — the revert-reintroduction guard.
 *
 * The documented failure: an agent re-adds code reverted last month, because
 * nothing in its context says the revert happened. The knowledge is in git;
 * nobody is reading it.
 */

describe('extractEntities', () => {
  it('finds declarations across the languages a repo reverts things in', () => {
    const text = [
      'export function computeDiscount(order) {}',
      'export class PaymentRetryQueue {}',
      'export const FEATURE_ROLLOUT = true;',
      'def calculate_shipping(order):',
      'CREATE TABLE user_sessions (id int);',
      'ALTER TABLE users ADD COLUMN legacy_flag boolean;',
    ].join('\n');

    const found = extractEntities(text);
    expect(found).toContain('computeDiscount');
    expect(found).toContain('PaymentRetryQueue');
    expect(found).toContain('FEATURE_ROLLOUT');
    expect(found).toContain('calculate_shipping');
    // The case a path-based check misses most often: the next migration gets a
    // new filename and looks like new work.
    expect(found).toContain('user_sessions');
    expect(found).toContain('legacy_flag');
  });

  it('ignores call sites — a use is not a reintroduction', () => {
    // Matching uses would fire on every file that merely references the name.
    expect(extractEntities('const total = computeDiscount(order);')).not.toContain(
      'computeDiscount',
    );
  });

  it('drops names too common to carry information', () => {
    const found = extractEntities('function handler() {}\nconst config = {};\nfunction main() {}');
    // A guard that fires on every diff declaring a `handler` is noise wearing a
    // warning's clothes.
    expect(found).toEqual([]);
  });

  it('drops names too short to be distinctive', () => {
    expect(extractEntities('function ab() {}')).toEqual([]);
  });

  it('is deduplicated and ordered', () => {
    const found = extractEntities(
      'function retryQueue(){}\nfunction retryQueue(){}\nclass Alpha{}',
    );
    expect(found).toEqual(['Alpha', 'retryQueue']);
  });
});

describe('removedLines / addedLines', () => {
  const diff = [
    '--- a/src/pay.ts',
    '+++ b/src/pay.ts',
    '-export function computeDiscount() {}',
    '+export function computeTotal() {}',
    ' unchanged',
  ].join('\n');

  it('separates the two sides', () => {
    expect(removedLines(diff)).toBe('export function computeDiscount() {}');
    expect(addedLines(diff)).toBe('export function computeTotal() {}');
  });

  it('does not mistake the file headers for content', () => {
    expect(removedLines(diff)).not.toContain('a/src/pay.ts');
    expect(addedLines(diff)).not.toContain('b/src/pay.ts');
  });
});

describe('checkReintroduction', () => {
  const reverted: RevertedEntity[] = [
    {
      name: 'computeDiscount',
      revertSha: 'abc123def456',
      subject: 'Revert "feat: discount engine" — double-charged 400 customers',
    },
  ];

  it('flags a re-added entity', () => {
    const result = checkReintroduction(reverted, 'export function computeDiscount() {}');
    expect(result.clean).toBe(false);
    expect(result.unacknowledged[0]?.entity).toBe('computeDiscount');
    // The reason for the original revert is the only thing that makes the
    // warning actionable.
    expect(result.unacknowledged[0]?.subject).toContain('double-charged');
  });

  it('flags it regardless of which file it comes back in', () => {
    // Matching by path would miss a rename, a move, or a fresh migration
    // number — which is exactly how a revert gets undone by accident.
    const result = checkReintroduction(reverted, 'export function computeDiscount() {}');
    expect(result.findings).toHaveLength(1);
  });

  it('passes a change that adds something unrelated', () => {
    const result = checkReintroduction(reverted, 'export function computeShipping() {}');
    expect(result.clean).toBe(true);
    expect(result.findings).toEqual([]);
  });

  it('accepts an explicit acknowledgment in the commit message', () => {
    const result = checkReintroduction(
      reverted,
      'export function computeDiscount() {}',
      'feat: reinstate discounts\n\nReintroduces: computeDiscount — root cause was the rounding bug, fixed in #412',
    );
    expect(result.clean).toBe(true);
    expect(result.findings[0]?.acknowledged).toBe(true);
  });

  it('keeps an acknowledged finding visible rather than filtering it out', () => {
    const result = checkReintroduction(
      reverted,
      'export function computeDiscount() {}',
      'Reintroduces: computeDiscount — fixed',
    );
    // Dropping it would make a deliberate reintroduction indistinguishable
    // from one nobody noticed.
    expect(result.findings).toHaveLength(1);
    expect(result.unacknowledged).toEqual([]);
  });

  it('does not let an acknowledgment of one entity clear another', () => {
    const two: RevertedEntity[] = [
      ...reverted,
      { name: 'legacy_flag', revertSha: 'def456', subject: 'Revert "add legacy flag"' },
    ];
    const result = checkReintroduction(
      two,
      'export function computeDiscount() {}\nALTER TABLE users ADD COLUMN legacy_flag boolean;',
      'Reintroduces: computeDiscount — fine now',
    );
    expect(result.unacknowledged.map((f) => f.entity)).toEqual(['legacy_flag']);
  });

  it('reports one finding per entity per revert', () => {
    const dupes = [...reverted, ...reverted];
    expect(checkReintroduction(dupes, 'function computeDiscount() {}').findings).toHaveLength(1);
  });

  it('is clean when nothing was ever reverted', () => {
    expect(checkReintroduction([], 'function computeDiscount() {}').clean).toBe(true);
  });
});

describe('acknowledgedEntities', () => {
  it('reads the trailer in its usual spellings', () => {
    expect(acknowledgedEntities('Reintroduces: alpha — because')).toEqual(['alpha']);
    expect(acknowledgedEntities('reintroduces: beta - because')).toEqual(['beta']);
    expect(acknowledgedEntities('Reintroduces: gamma')).toEqual(['gamma']);
  });

  it('reads several', () => {
    expect(acknowledgedEntities('Reintroduces: alpha — a\nReintroduces: beta — b')).toEqual([
      'alpha',
      'beta',
    ]);
  });

  it('finds nothing in a message without one', () => {
    expect(acknowledgedEntities('feat: ordinary change')).toEqual([]);
  });
});

describe('formatGuard', () => {
  const reverted: RevertedEntity[] = [
    { name: 'computeDiscount', revertSha: 'abc123def456', subject: 'Revert "discounts"' },
  ];

  it('offers the exact trailer to paste', () => {
    const text = formatGuard(checkReintroduction(reverted, 'function computeDiscount() {}'));
    // Telling someone a rule exists without telling them how to satisfy it is
    // how a guard becomes something people route around.
    expect(text).toContain('Reintroduces: computeDiscount —');
  });

  it('does not claim the change is wrong', () => {
    const text = formatGuard(checkReintroduction(reverted, 'function computeDiscount() {}'));
    expect(text).toContain('does not mean they are wrong now');
  });

  it('says so plainly when there is nothing to report', () => {
    expect(formatGuard(checkReintroduction(reverted, 'function other() {}'))).toContain(
      'nothing in this change was previously reverted',
    );
  });
});
