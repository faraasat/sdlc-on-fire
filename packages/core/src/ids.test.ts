import { describe, expect, it } from 'vitest';
import {
  AdrIdSchema,
  formatWorkItemId,
  InsertionIdSchema,
  parseWorkItemId,
  WorkItemIdSchema,
} from './ids.js';

describe('work-item IDs', () => {
  it('zero-pads to three digits', () => {
    expect(formatWorkItemId('story', 14)).toBe('STORY-014');
  });

  it('abbreviates feature to FEAT rather than uppercasing the kind', () => {
    expect(formatWorkItemId('feature', 7)).toBe('FEAT-007');
  });

  it('widens rather than truncates past the padding width', () => {
    // Truncating here would silently collide TASK-1000 with TASK-000.
    expect(formatWorkItemId('task', 1000)).toBe('TASK-1000');
  });

  it('rejects a non-positive or fractional sequence', () => {
    expect(() => formatWorkItemId('task', 0)).toThrow(RangeError);
    expect(() => formatWorkItemId('task', -1)).toThrow(RangeError);
    expect(() => formatWorkItemId('task', 1.5)).toThrow(RangeError);
  });

  it('round-trips through parse', () => {
    for (const kind of ['epic', 'story', 'feature', 'bug', 'task'] as const) {
      const id = formatWorkItemId(kind, 42);
      expect(parseWorkItemId(id)).toEqual({ kind, sequence: 42 });
    }
  });

  it('returns null for an unrecognised prefix instead of throwing', () => {
    expect(parseWorkItemId('CARD-001')).toBeNull();
    expect(parseWorkItemId('not-an-id')).toBeNull();
    expect(parseWorkItemId('TASK-')).toBeNull();
  });

  it('accepts every well-formed ID and rejects lookalikes', () => {
    expect(WorkItemIdSchema.safeParse('BUG-042').success).toBe(true);
    expect(WorkItemIdSchema.safeParse('bug-042').success).toBe(false);
    expect(WorkItemIdSchema.safeParse('BUG-42').success).toBe(false);
    expect(WorkItemIdSchema.safeParse('CARD-042').success).toBe(false);
  });
});

describe('ADR and insertion IDs', () => {
  it('requires a four-digit sequence and a kebab-case slug', () => {
    expect(AdrIdSchema.safeParse('ADR-0013-immutable-completed-work').success).toBe(true);
    expect(AdrIdSchema.safeParse('ADR-13-immutable').success).toBe(false);
    expect(AdrIdSchema.safeParse('ADR-0013-Immutable_Work').success).toBe(false);
    expect(AdrIdSchema.safeParse('ADR-0013').success).toBe(false);
  });

  it('accepts insertion IDs only in the daemon-assigned shape', () => {
    expect(InsertionIdSchema.safeParse('INSERT-014').success).toBe(true);
    expect(InsertionIdSchema.safeParse('INSERTION-014').success).toBe(false);
  });
});
