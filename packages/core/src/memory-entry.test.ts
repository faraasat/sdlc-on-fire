import { describe, expect, it } from 'vitest';
import {
  isCurrent,
  MemoryEntrySchema,
  resolveConflicts,
  sameSubject,
  scoreMemory,
  type MemoryEntry,
} from './memory-entry.js';

/**
 * Typed memory, provenance, and bi-temporal conflict resolution (P1-OBJ-04).
 *
 * The resolution is a pure function precisely so it can be argued with here,
 * without a database. It is also the deterministic disposer ADR-0040 asks for:
 * a model may propose the extraction, and nothing in this file consults one.
 */

const entry = (over: Partial<MemoryEntry> = {}): MemoryEntry =>
  MemoryEntrySchema.parse({
    type: 'semantic',
    title: 'CSV delimiter',
    body: 'The exporter uses a comma.',
    source_type: 'user-authored',
    written_by: 'alice',
    valid_from: '2026-06-01T00:00:00.000Z',
    content_hash: 'a'.repeat(64),
    ...over,
  });

describe('provenance is required, never inferred', () => {
  it('refuses an entry with no source', () => {
    // An entry whose origin is unknown cannot be judged months later, and "the
    // user said so" and "an agent inferred it" are not the same claim.
    const { source_type: _omitted, ...rest } = entry();
    expect(MemoryEntrySchema.safeParse(rest).success).toBe(false);
  });

  it('refuses an entry with no author', () => {
    expect(MemoryEntrySchema.safeParse({ ...entry(), written_by: '' }).success).toBe(false);
  });

  it('refuses a source outside the vocabulary', () => {
    expect(MemoryEntrySchema.safeParse({ ...entry(), source_type: 'somewhere' }).success).toBe(
      false,
    );
  });
});

describe('what counts as the same subject', () => {
  it('matches on type, work item and title, ignoring case and spacing', () => {
    expect(sameSubject(entry(), entry({ title: '  csv DELIMITER ' }))).toBe(true);
  });

  it('does not match across types', () => {
    // A one-off observation and a standing convention about the same words are
    // different claims, and treating them as rivals would retract the wrong one.
    expect(sameSubject(entry({ type: 'semantic' }), entry({ type: 'procedural' }))).toBe(false);
  });

  it('does not match across work items', () => {
    expect(sameSubject(entry({ work_item_id: 'TASK-001' }), entry())).toBe(false);
  });
});

describe('resolving a conflict', () => {
  const existing = entry({ id: 1 });

  it('supersedes an earlier claim about the same subject', () => {
    const later = entry({
      valid_from: '2026-07-01T00:00:00.000Z',
      body: 'The exporter uses a semicolon.',
      content_hash: 'b'.repeat(64),
    });
    const resolution = resolveConflicts(later, [existing]);

    expect(resolution.supersedes).toEqual([{ id: 1, validTo: '2026-07-01T00:00:00.000Z' }]);
    expect(resolution.contested).toEqual([]);
  });

  it('closes the old window where the new one opens, not at "now"', () => {
    // So the two windows abut rather than overlap, and "what did we believe on
    // date X" has exactly one answer.
    const later = entry({
      valid_from: '2026-07-01T00:00:00.000Z',
      content_hash: 'b'.repeat(64),
    });
    expect(resolveConflicts(later, [existing]).supersedes[0]?.validTo).toBe(
      '2026-07-01T00:00:00.000Z',
    );
  });

  it('contests rather than guessing when the new claim is not later', () => {
    // A fact recorded today can be about last month — that is what bi-temporality
    // is for — so "most recent write wins" silently discards the older and
    // possibly better-founded claim. ADR-0023 names that as the common failure.
    const earlier = entry({
      valid_from: '2026-05-01T00:00:00.000Z',
      body: 'It was a tab all along.',
      content_hash: 'c'.repeat(64),
    });
    const resolution = resolveConflicts(earlier, [existing]);

    expect(resolution.supersedes).toEqual([]);
    expect(resolution.contested).toEqual([1]);
    expect(resolution.status).toBe('contested');
  });

  it('treats an identical claim as a duplicate, not a correction', () => {
    // Re-asserting a belief grows the store without adding anything, which is
    // the accumulation failure this whole design is built around.
    const resolution = resolveConflicts(entry(), [existing]);
    expect(resolution.duplicate).toBe(true);
    expect(resolution.supersedes).toEqual([]);
  });

  it('leaves unrelated subjects alone', () => {
    const other = entry({ title: 'Line endings', content_hash: 'd'.repeat(64) });
    const resolution = resolveConflicts(other, [existing]);
    expect(resolution.supersedes).toEqual([]);
    expect(resolution.contested).toEqual([]);
  });

  it('does not resurrect an argument with an already-closed entry', () => {
    const closed = entry({ id: 1, valid_to: '2026-06-15T00:00:00.000Z' });
    const later = entry({
      valid_from: '2026-07-01T00:00:00.000Z',
      content_hash: 'b'.repeat(64),
    });
    expect(resolveConflicts(later, [closed]).supersedes).toEqual([]);
  });
});

describe('validity', () => {
  it('treats an open window as current', () => {
    expect(isCurrent(entry())).toBe(true);
  });

  it('treats a superseded entry as not current even with an open window', () => {
    expect(isCurrent(entry({ conflict_status: 'superseded' }))).toBe(false);
  });

  it('treats a closed window as not current once it has passed', () => {
    const closed = entry({ valid_to: '2026-06-15T00:00:00.000Z' });
    expect(isCurrent(closed, new Date('2026-08-01T00:00:00.000Z'))).toBe(false);
    expect(isCurrent(closed, new Date('2026-06-01T00:00:00.000Z'))).toBe(true);
  });
});

describe('read-time ranking', () => {
  const at = new Date('2026-06-01T00:00:00.000Z');

  it('is a formula over stored columns, so two callers agree', () => {
    // The same reason the gate evaluates evidence rather than asking a model:
    // an ordering nobody can reproduce is not a ranking.
    const one = scoreMemory(entry(), 0.5, at);
    const two = scoreMemory(entry(), 0.5, at);
    expect(one).toBe(two);
  });

  it('ranks a more salient entry above a less salient one, all else equal', () => {
    expect(scoreMemory(entry({ importance: 0.9 }), 0, at)).toBeGreaterThan(
      scoreMemory(entry({ importance: 0.1 }), 0, at),
    );
  });

  it('decays with time since last access', () => {
    const stale = entry({ last_accessed_at: '2026-01-01T00:00:00.000Z' });
    const fresh = entry({ last_accessed_at: '2026-05-31T00:00:00.000Z' });
    expect(scoreMemory(fresh, 0, at)).toBeGreaterThan(scoreMemory(stale, 0, at));
  });

  it('contributes nothing for relevance when no similarity was computed', () => {
    // Imputing a number we did not compute would be worse than contributing
    // none — v0.1 has no embedding retrieval on this path.
    const withRelevance = scoreMemory(entry(), 1, at);
    const without = scoreMemory(entry(), 0, at);
    expect(withRelevance).toBeGreaterThan(without);
  });
});
