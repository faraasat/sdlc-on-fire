import { describe, expect, it } from 'vitest';
import {
  COMPROMISE_PLAYBOOK,
  diffWatch,
  formatWatchDelta,
  watchSeverity,
  type WatchRecord,
} from './compromise-watch.js';

/**
 * P2-SEC-09 — retroactive compromised-package detection.
 *
 * The case this exists for: a package that was clean when installed, and is
 * not clean now, with nothing about this project having changed.
 */

const record = (packages: WatchRecord['packages']): WatchRecord => ({
  polledAt: '2026-01-01T00:00:00.000Z',
  source: 'osv.dev',
  packages,
});

describe('diffWatch', () => {
  it('reports a baseline on the first run and flags nothing', () => {
    const delta = diffWatch(null, [{ name: 'axios', version: '1.6.0', advisories: ['GHSA-aaa'] }]);
    // Reporting every existing advisory as "newly discovered" on day one buries
    // the one that appears on day two — and a tool whose first output is a
    // hundred urgent findings teaches people its findings are not urgent.
    expect(delta.baseline).toBe(true);
    expect(delta.findings).toEqual([]);
    expect(delta.unchanged).toBe(1);
  });

  it('flags an advisory newly attached to an already-installed package', () => {
    const previous = record([{ name: 'axios', version: '1.6.0', advisories: [] }]);
    const delta = diffWatch(previous, [
      { name: 'axios', version: '1.6.0', advisories: ['GHSA-new'] },
    ]);

    // The compromise case exactly: same project, same version, different answer.
    expect(delta.findings).toHaveLength(1);
    expect(delta.findings[0]?.newAdvisories).toEqual(['GHSA-new']);
    expect(delta.findings[0]?.firstSeen).toBe(false);
    expect(watchSeverity(delta.findings[0]!)).toBe('urgent');
  });

  it('reports only the advisories that are new', () => {
    const previous = record([{ name: 'axios', version: '1.6.0', advisories: ['GHSA-old'] }]);
    const delta = diffWatch(previous, [
      { name: 'axios', version: '1.6.0', advisories: ['GHSA-old', 'GHSA-new'] },
    ]);
    // A poll re-reporting everything known produces a wall people stop reading.
    expect(delta.findings[0]?.newAdvisories).toEqual(['GHSA-new']);
  });

  it('says nothing changed when nothing changed', () => {
    const previous = record([{ name: 'axios', version: '1.6.0', advisories: ['GHSA-old'] }]);
    const delta = diffWatch(previous, [
      { name: 'axios', version: '1.6.0', advisories: ['GHSA-old'] },
    ]);
    expect(delta.findings).toEqual([]);
    expect(delta.unchanged).toBe(1);
  });

  it('treats a version change as a different question', () => {
    const previous = record([{ name: 'axios', version: '1.6.0', advisories: ['GHSA-old'] }]);
    const delta = diffWatch(previous, [
      { name: 'axios', version: '1.7.0', advisories: ['GHSA-old'] },
    ]);
    // A compromise attaches to a published version. Matching on name alone
    // would let an upgrade into a backdoored version look like no change.
    expect(delta.findings).toHaveLength(1);
    expect(delta.findings[0]?.firstSeen).toBe(true);
  });

  it('ranks a newly-added package below a newly-compromised one', () => {
    const previous = record([{ name: 'stable', version: '1.0.0', advisories: [] }]);
    const delta = diffWatch(previous, [
      { name: 'stable', version: '1.0.0', advisories: ['GHSA-x'] },
      { name: 'added', version: '2.0.0', advisories: ['GHSA-y'] },
    ]);

    const added = delta.findings.find((f) => f.name === 'added');
    const stable = delta.findings.find((f) => f.name === 'stable');
    // A new dependency carrying a known advisory is something the install gate
    // already asked about. An advisory landing on a package nobody touched is
    // the one that means something is wrong.
    expect(watchSeverity(added!)).toBe('review');
    expect(watchSeverity(stable!)).toBe('urgent');
  });

  it('is stable across runs over the same state', () => {
    const previous = record([]);
    const current = [
      { name: 'b', version: '1.0.0', advisories: ['GHSA-1'] },
      { name: 'a', version: '1.0.0', advisories: ['GHSA-1', 'GHSA-2'] },
    ];
    const once = diffWatch(previous, current).findings.map((f) => f.name);
    const twice = diffWatch(previous, [...current].reverse()).findings.map((f) => f.name);
    // Worst first, then by name — so the report is diffable.
    expect(once).toEqual(['a', 'b']);
    expect(twice).toEqual(once);
  });

  it('does not flag a package that disappeared from the tree', () => {
    const previous = record([{ name: 'removed', version: '1.0.0', advisories: ['GHSA-x'] }]);
    expect(diffWatch(previous, []).findings).toEqual([]);
  });
});

describe('formatWatchDelta', () => {
  it('explains why a baseline reports nothing', () => {
    const text = formatWatchDelta(diffWatch(null, []), 'osv.dev');
    expect(text).toContain('Baseline');
    expect(text).toContain('first run');
  });

  it('prints the response playbook when something is urgent', () => {
    const previous = record([{ name: 'axios', version: '1.6.0', advisories: [] }]);
    const text = formatWatchDelta(
      diffWatch(previous, [{ name: 'axios', version: '1.6.0', advisories: ['GHSA-new'] }]),
      'osv.dev',
    );
    // The playbook is the point of the alert. An alert with no next step is a
    // notification.
    expect(text).toContain('Rotate every credential');
    expect(text).toContain(COMPROMISE_PLAYBOOK[0]);
  });

  it('does not print the playbook for a merely-new package', () => {
    const previous = record([]);
    const text = formatWatchDelta(
      diffWatch(previous, [{ name: 'added', version: '1.0.0', advisories: ['GHSA-y'] }]),
      'osv.dev',
    );
    expect(text).toContain('REVIEW');
    expect(text).not.toContain('Rotate every credential');
  });

  it('states plainly when a poll found nothing new', () => {
    const previous = record([{ name: 'a', version: '1.0.0', advisories: [] }]);
    const text = formatWatchDelta(
      diffWatch(previous, [{ name: 'a', version: '1.0.0', advisories: [] }]),
      'osv.dev',
    );
    expect(text).toContain('No new advisories');
  });
});
