import { describe, expect, it } from 'vitest';
import {
  BLOCKING_EFFECTS,
  buildFeed,
  needsAttention,
  severityForEffect,
  type CommentEvent,
} from './activity.js';
import { ROLE_EFFECTS } from './comment-effect.js';

/**
 * P4-COLLAB-01 — the activity feed.
 *
 * A board shows state; a feed shows what happened. The things that leave no
 * trace on a card face — a comment that blocked a gate, a run that failed and
 * was retried, a card that went backwards — are exactly what somebody is
 * looking for when they open a board asking "what changed".
 */

const comment = (over: Partial<CommentEvent> = {}): CommentEvent => ({
  work_item_id: 'FEAT-1',
  type: 'blocker',
  role_effect: 'GATE_BLOCK',
  body: 'this cannot ship',
  created_at: '2026-08-22T10:00:00Z',
  ...over,
});

describe('severityForEffect', () => {
  it('reads a gate-blocking effect as blocking', () => {
    expect(severityForEffect('GATE_BLOCK')).toBe('blocking');
  });

  it('groups the effects that mean "a person is now waiting"', () => {
    // Different names, same practical meaning to whoever reads the feed.
    for (const effect of BLOCKING_EFFECTS) {
      expect(severityForEffect(effect), effect).toBe('blocking');
    }
  });

  it('has an answer for every effect the model can produce', () => {
    // A feed that silently dropped an unrecognised effect would hide exactly
    // the comment somebody added a new effect for.
    for (const effect of ROLE_EFFECTS) {
      expect(severityForEffect(effect), effect).toBeTruthy();
    }
  });

  it('does not treat an ordinary comment as loud', () => {
    expect(severityForEffect('NONE')).toBe('normal');
  });
});

describe('buildFeed', () => {
  it('carries the computed effect rather than re-deriving it', () => {
    // `role_effect` is computed server-side at insert and never re-derived
    // downstream (ADR-0012). A feed that inferred it from the type would be a
    // second implementation of the one thing the comment model exists to make
    // unambiguous.
    const feed = buildFeed({ comments: [comment({ type: 'normal', role_effect: 'GATE_BLOCK' })] });
    expect(feed[0]?.effect).toBe('GATE_BLOCK');
    expect(feed[0]?.severity).toBe('blocking');
  });

  it('merges every source into one reverse-chronological stream', () => {
    const feed = buildFeed({
      transitions: [
        {
          work_item_id: 'A',
          from_state: 'spec',
          to_state: 'implement',
          created_at: '2026-08-22T09:00:00Z',
        },
      ],
      comments: [comment({ created_at: '2026-08-22T11:00:00Z' })],
      gates: [
        {
          work_item_id: 'A',
          gate_name: 'tests',
          result: 'fail',
          updated_at: '2026-08-22T10:00:00Z',
        },
      ],
    });
    expect(feed.map((entry) => entry.kind)).toEqual(['comment', 'gate', 'transition']);
  });

  it('truncates after merging, never before', () => {
    // Truncating each source first gives a feed whose oldest entries are
    // whichever source happened to be quiet — a busy comment thread would push
    // out every gate result and the feed would stop being a record.
    const feed = buildFeed({
      comments: Array.from({ length: 10 }, (_, index) =>
        comment({ created_at: `2026-08-22T1${String(index)}:00:00Z` }),
      ),
      gates: [
        {
          work_item_id: 'A',
          gate_name: 'tests',
          result: 'fail',
          updated_at: '2026-08-22T23:00:00Z',
        },
      ],
      limit: 3,
    });
    expect(feed).toHaveLength(3);
    // The newest thing overall is the gate, and it survived.
    expect(feed[0]?.kind).toBe('gate');
  });

  it('describes a first entry differently from a move', () => {
    const feed = buildFeed({
      transitions: [
        {
          work_item_id: 'A',
          from_state: null,
          to_state: 'intake',
          created_at: '2026-08-22T09:00:00Z',
        },
      ],
    });
    expect(feed[0]?.summary).toBe('entered intake');
  });

  it('reads a failing gate as blocking and a pending one as quiet', () => {
    // A pending gate is not news. Rendering it at the same weight as a failure
    // is how a feed becomes something people scroll past.
    const feed = buildFeed({
      gates: [
        { work_item_id: 'A', gate_name: 'a', result: 'fail', updated_at: '2026-08-22T10:00:00Z' },
        {
          work_item_id: 'A',
          gate_name: 'b',
          result: 'pending',
          updated_at: '2026-08-22T09:00:00Z',
        },
      ],
    });
    expect(feed.map((entry) => entry.severity)).toEqual(['blocking', 'quiet']);
  });

  it('marks an agent-driven run as agent activity', () => {
    const feed = buildFeed({
      runs: [
        {
          work_item_id: 'A',
          id: 'r1',
          status: 'fail',
          updated_at: '2026-08-22T10:00:00Z',
          agent_target: 'claude-code',
        },
      ],
    });
    expect(feed[0]?.actorKind).toBe('agent');
    expect(feed[0]?.severity).toBe('attention');
  });

  it('shortens a long comment to one scannable line', () => {
    const feed = buildFeed({
      comments: [comment({ body: `${'x'.repeat(300)}\nsecond line` })],
    });
    expect(feed[0]?.summary.length).toBeLessThanOrEqual(90);
    expect(feed[0]?.summary).not.toContain('second line');
  });

  it('skips leading blank lines rather than summarising nothing', () => {
    const feed = buildFeed({ comments: [comment({ body: '\n\n  the real first line' })] });
    expect(feed[0]?.summary.trim()).toBe('the real first line');
  });

  it('is empty for a workspace where nothing happened', () => {
    expect(buildFeed({})).toEqual([]);
  });
});

describe('needsAttention', () => {
  it('keeps only what a person has to look at', () => {
    const feed = buildFeed({
      comments: [comment({ role_effect: 'GATE_BLOCK' }), comment({ role_effect: 'NONE' })],
      gates: [
        { work_item_id: 'A', gate_name: 'a', result: 'pass', updated_at: '2026-08-22T08:00:00Z' },
      ],
    });
    expect(needsAttention(feed)).toHaveLength(1);
    expect(needsAttention(feed)[0]?.effect).toBe('GATE_BLOCK');
  });
});
