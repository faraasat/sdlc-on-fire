import { describe, expect, it } from 'vitest';
import {
  checkFreshness,
  renderDecisionLog,
  renderHistory,
  type FreshnessInput,
} from './doc-freshness.js';

/**
 * P1-DOC-01 — doc freshness (ADR-0046).
 *
 * The ADR is honest that this check is heuristic and cannot prove semantic
 * staleness. So the tests are mostly about the *boundary*: what it is entitled
 * to fail on, and what it may only mention.
 */

const NOW = new Date('2026-08-10T00:00:00.000Z');

const input = (over: Partial<FreshnessInput> = {}): FreshnessInput => ({
  docs: [{ path: 'docs/importer.md', covers: ['src/importer/**'] }],
  changedFiles: [],
  changedDocs: [],
  now: NOW,
  ...over,
});

describe('what it may fail on', () => {
  it('fails only on a link that resolves to nothing', () => {
    const report = checkFreshness(
      input({
        docs: [
          {
            path: 'docs/importer.md',
            covers: [],
            links: [{ target: 'docs/gone.md', resolves: false }],
          },
        ],
      }),
    );
    // The one fact here: a link either resolves or it does not, and a reader
    // following it lands nowhere. No judgement involved.
    expect(report.ok).toBe(false);
    expect(report.findings[0]?.kind).toBe('broken-link');
  });

  it('only advises when code changed and the doc did not', () => {
    const report = checkFreshness(
      input({ changedFiles: ['src/importer/csv.ts'], changedDocs: [] }),
    );
    expect(report.findings[0]?.kind).toBe('code-changed-doc-did-not');
    // Plenty of code changes do not affect what a doc says, and a gate here
    // would be failed by every rename.
    expect(report.ok).toBe(true);
    expect(report.advisory).toHaveLength(1);
  });

  it('says nothing when the doc changed alongside the code', () => {
    const report = checkFreshness(
      input({ changedFiles: ['src/importer/csv.ts'], changedDocs: ['docs/importer.md'] }),
    );
    expect(report.findings).toEqual([]);
  });

  it('only advises on an expired refresh-by', () => {
    const report = checkFreshness(
      input({ docs: [{ path: 'docs/research/pglite.md', covers: [], refreshBy: '2026-01-01' }] }),
    );
    // The one class that goes stale on a clock rather than a diff: a library's
    // docs move whether or not this repo does.
    expect(report.findings[0]?.kind).toBe('refresh-by-expired');
    expect(report.ok).toBe(true);
  });

  it('does not flag a refresh-by still in the future', () => {
    const report = checkFreshness(
      input({ docs: [{ path: 'docs/research/pglite.md', covers: [], refreshBy: '2027-01-01' }] }),
    );
    expect(report.findings).toEqual([]);
  });

  it('only advises on a count that drifted', () => {
    const report = checkFreshness(
      input({
        docs: [
          {
            path: 'docs/packages.md',
            covers: [],
            counts: [{ label: 'packages', claimed: 6, actual: 8 }],
          },
        ],
      }),
    );
    expect(report.findings[0]?.detail).toContain('there are 8');
    expect(report.ok).toBe(true);
  });

  it('reports every kind of drift at once', () => {
    const report = checkFreshness(
      input({
        docs: [
          {
            path: 'docs/importer.md',
            covers: ['src/importer/**'],
            refreshBy: '2026-01-01',
            links: [{ target: 'gone.md', resolves: false }],
            counts: [{ label: 'steps', claimed: 3, actual: 4 }],
          },
        ],
        changedFiles: ['src/importer/csv.ts'],
      }),
    );
    expect(report.findings).toHaveLength(4);
    expect(report.ok).toBe(false);
  });
});

describe('the three logs', () => {
  it('keeps a history entry to one line', () => {
    const text = renderHistory([
      { date: '2026-08-10', summary: 'a'.repeat(500), workItemId: 'FEAT-001' },
    ]);
    // ADR-0046 names essay-length entries as what makes the discipline
    // collapse: a log nobody can skim is a log nobody reads, and one nobody
    // reads stops being written.
    const entry = text.split('\n').find((line) => line.startsWith('- **2026-08-10**')) ?? '';
    expect(entry.length).toBeLessThan(220);
    expect(entry).toContain('…');
  });

  it('orders history newest first', () => {
    const text = renderHistory([
      { date: '2026-01-01', summary: 'older' },
      { date: '2026-08-10', summary: 'newer' },
    ]);
    expect(text.indexOf('newer')).toBeLessThan(text.indexOf('older'));
  });

  it('logs decision changes without restating the rationale', () => {
    const text = renderDecisionLog([
      {
        date: '2026-08-10',
        adr: 'ADR-0009',
        kind: 'superseded',
        because: 'the stage ladder became work-type keyed',
        supersededBy: 'ADR-0070',
      },
    ]);
    expect(text).toContain('ADR-0009 superseded → ADR-0070');
    // Duplicating the reasoning here would create a second account of the same
    // decision, and two accounts disagree eventually.
    expect(text).toContain('authoritative');
  });
});
