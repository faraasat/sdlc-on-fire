import { describe, expect, it } from 'vitest';
import {
  NOTIFICATION_TIERS,
  fanOut,
  isImmediate,
  parseMentions,
  tierFor,
  type Recipient,
} from './notification.js';

/**
 * P4-COLLAB-02 — notification tiers and fan-out.
 *
 * Two failure modes drive nearly every assertion here, and they pull in
 * opposite directions: paging somebody for nothing teaches them to mute the
 * product, and batching the one blocking thing means the interruption never
 * arrives. Both are silent.
 */

describe('parseMentions', () => {
  it('finds a user and a role', () => {
    const mentions = parseMentions('@ana can you look, and @security should weigh in');
    expect(mentions).toEqual([
      { handle: 'ana', kind: 'user' },
      { handle: 'security', kind: 'role' },
    ]);
  });

  it('does not treat an email address as a mention', () => {
    // Paging the "example" role because somebody pasted an address is both
    // wrong and unexplainable to the person paged.
    expect(parseMentions('mail me at foo@example.com')).toEqual([]);
  });

  it('ignores mentions inside fenced code', () => {
    // Being paged by somebody's pasted log output is the fastest way to make
    // people stop reading notifications.
    // The mention inside the fence is written exactly as a real one would be —
    // preceded by whitespace, at the start of a line. An earlier version of
    // this test used `deploy(@qa)`, which the mention pattern rejects anyway
    // for its leading bracket, so it passed with fence-stripping removed.
    const body = ['see the log:', '```', 'WARN @qa retry failed', '```', 'thanks'].join('\n');
    expect(parseMentions(body)).toEqual([]);
    // Control: the identical text outside a fence *is* a mention, so the
    // assertion above is about the fence and not about the pattern.
    expect(parseMentions('WARN @qa retry failed')).toEqual([{ handle: 'qa', kind: 'role' }]);
  });

  it('ignores mentions inside inline code', () => {
    expect(parseMentions('the literal `@security` annotation')).toEqual([]);
  });

  it('deduplicates a handle mentioned repeatedly', () => {
    // Three mentions in one comment is one notification, not three.
    expect(parseMentions('@ana @ana and again @ana')).toHaveLength(1);
  });

  it('is case-insensitive and normalises', () => {
    expect(parseMentions('@Ana @ANA')).toEqual([{ handle: 'ana', kind: 'user' }]);
  });

  it('recognises a mention at the very start of a body', () => {
    expect(parseMentions('@qa please verify')).toEqual([{ handle: 'qa', kind: 'role' }]);
  });

  it('classifies only the closed role vocabulary as roles', () => {
    expect(parseMentions('@qa @devops')).toEqual([
      { handle: 'qa', kind: 'role' },
      { handle: 'devops', kind: 'user' },
    ]);
  });

  it('returns nothing for a body with no mentions', () => {
    expect(parseMentions('just a normal comment')).toEqual([]);
  });
});

describe('tierFor', () => {
  it('makes a blocking effect instant', () => {
    expect(tierFor({ effect: 'GATE_BLOCK' })).toBe('instant');
    expect(tierFor({ effect: 'REQUIRED_CHANGE' })).toBe('instant');
    expect(tierFor({ effect: 'BUG_CREATION' })).toBe('instant');
  });

  it('makes a direct mention instant', () => {
    expect(tierFor({ mentioned: true })).toBe('instant');
  });

  it('reads the stored effect, never the comment type', () => {
    // ADR-0012. A `normal`-typed comment whose resolved effect is GATE_BLOCK is
    // blocking; deriving urgency from the type would call it a digest entry.
    expect(tierFor({ effect: 'GATE_BLOCK', mentioned: false })).toBe('instant');
  });

  it('batches an attention effect', () => {
    expect(tierFor({ effect: 'RESCOPE' })).toBe('batched');
    expect(tierFor({ effect: 'UX_ACCEPTANCE_UPDATE' })).toBe('batched');
  });

  it('batches a card resting on a human-gated stage', () => {
    expect(tierFor({ needsHuman: true })).toBe('batched');
  });

  it('digests everything else', () => {
    expect(tierFor({})).toBe('digest');
    expect(tierFor({ effect: 'NONE' })).toBe('digest');
    expect(tierFor({ effect: null })).toBe('digest');
  });

  it('prefers the more urgent reason when several apply', () => {
    expect(tierFor({ effect: 'GATE_BLOCK', needsHuman: true })).toBe('instant');
    expect(tierFor({ effect: 'RESCOPE', mentioned: true })).toBe('instant');
  });
});

describe('fanOut', () => {
  const people: Recipient[] = [
    { actorId: 'a1', handle: 'ana', roles: ['security'] },
    { actorId: 'a2', handle: 'bo', roles: ['qa'] },
    { actorId: 'a3', handle: 'cy', roles: [] },
  ];

  it('notifies a directly mentioned person', () => {
    const out = fanOut({ mentions: parseMentions('@bo look'), recipients: people });
    expect(out.map((n) => n.actorId)).toEqual(['a2']);
    expect(out[0]?.because).toBe('@bo');
  });

  it('expands a role to everyone holding it', () => {
    const out = fanOut({ mentions: parseMentions('@security please'), recipients: people });
    expect(out.map((n) => n.actorId)).toEqual(['a1']);
    expect(out[0]?.because).toBe('@security (role)');
  });

  it('notifies a person named twice exactly once', () => {
    // The duplicate that is easiest to introduce: two matching paths converging
    // on one human. Duplicate delivery is what makes people mute a channel.
    const out = fanOut({ mentions: parseMentions('@ana @security'), recipients: people });
    expect(out).toHaveLength(1);
    expect(out[0]?.actorId).toBe('a1');
  });

  it('never notifies the author of their own comment', () => {
    const out = fanOut({
      mentions: parseMentions('@ana @bo'),
      recipients: people,
      authorActorId: 'a1',
    });
    expect(out.map((n) => n.actorId)).toEqual(['a2']);
  });

  it('notifies nobody when nobody is mentioned', () => {
    expect(fanOut({ mentions: parseMentions('no mentions here'), recipients: people })).toEqual([]);
  });

  it('ignores a mention that matches no one', () => {
    expect(fanOut({ mentions: parseMentions('@nobody'), recipients: people })).toEqual([]);
  });

  it('carries the effect into the tier', () => {
    const out = fanOut({
      mentions: parseMentions('@bo'),
      recipients: people,
      effect: 'GATE_BLOCK',
    });
    expect(out[0]?.tier).toBe('instant');
  });

  it('orders by actor so delivery is deterministic', () => {
    // Recipients are deliberately supplied out of order. Listing them already
    // sorted makes Map insertion order coincide with the sort, and the
    // assertion holds with the sort removed entirely.
    const shuffled: Recipient[] = [
      { actorId: 'a3', handle: 'cy', roles: [] },
      { actorId: 'a1', handle: 'ana', roles: ['security'] },
      { actorId: 'a2', handle: 'bo', roles: ['qa'] },
    ];
    const out = fanOut({ mentions: parseMentions('@cy @ana @bo'), recipients: shuffled });
    expect(out.map((n) => n.actorId)).toEqual(['a1', 'a2', 'a3']);
  });
});

describe('isImmediate', () => {
  it('is true only for instant', () => {
    expect(isImmediate('instant')).toBe(true);
    expect(isImmediate('batched')).toBe(false);
    expect(isImmediate('digest')).toBe(false);
  });

  it('covers every declared tier', () => {
    for (const tier of NOTIFICATION_TIERS) expect(typeof isImmediate(tier)).toBe('boolean');
  });
});
