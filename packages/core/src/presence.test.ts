import { describe, expect, it } from 'vitest';
import {
  mergeByField,
  Presence,
  PRESENCE_TTL_MS,
  type PresenceEntry,
  stampAll,
  viewers,
} from './presence.js';

/**
 * P3-RT-02 — per-field reconciliation and ephemeral presence.
 *
 * The failure both guard against is a UI that is confidently wrong: a change
 * silently reverted by somebody editing a different field, or a presence list
 * showing a person who closed their laptop an hour ago.
 */

const T1 = '2026-08-22T10:00:00.000Z';
const T2 = '2026-08-22T11:00:00.000Z';

describe('mergeByField', () => {
  it('lets two people edit different fields of one card without either losing', () => {
    // Whole-row last-writer-wins reverts fields the later writer never touched,
    // and the person who loses is never told: their change was accepted,
    // rendered, then quietly undone by somebody editing something else.
    const local = { values: { title: 'mine', stage: 'spec' }, stamps: { title: T2, stage: T1 } };
    const incoming = {
      values: { title: 'theirs', stage: 'implement' },
      stamps: { title: T1, stage: T2 },
    };

    const merged = mergeByField(local, incoming);
    expect(merged.values['title']).toBe('mine');
    expect(merged.values['stage']).toBe('implement');
    expect(merged.kept).toEqual(['title']);
    expect(merged.overwritten).toEqual(['stage']);
  });

  it('takes the incoming value when the timestamps tie', () => {
    // The server's copy is what everybody else already sees. Preferring the
    // local one leaves a single browser disagreeing with every other, and with
    // itself after a reload.
    const merged = mergeByField(
      { values: { title: 'mine' }, stamps: { title: T1 } },
      { values: { title: 'theirs' }, stamps: { title: T1 } },
    );
    expect(merged.values['title']).toBe('theirs');
  });

  it('accepts a field the client has never had an opinion about', () => {
    const merged = mergeByField(
      { values: {}, stamps: {} },
      { values: { risk: 'high' }, stamps: { risk: T1 } },
    );
    expect(merged.values['risk']).toBe('high');
  });

  it('does not let an unstamped write beat a stamped one', () => {
    // Otherwise any write that forgot its timestamp silently wins every
    // conflict, which inverts the whole rule.
    const merged = mergeByField(
      { values: { title: 'mine' }, stamps: { title: T2 } },
      { values: { title: 'theirs' }, stamps: {} },
    );
    expect(merged.values['title']).toBe('mine');
  });

  it('reports overwritten only when the value actually changed', () => {
    // A newer write of an identical value is not something a user needs told
    // about; reporting it would make "your change was replaced" noise.
    const merged = mergeByField(
      { values: { title: 'same' }, stamps: { title: T1 } },
      { values: { title: 'same' }, stamps: { title: T2 } },
    );
    expect(merged.overwritten).toEqual([]);
  });

  it('leaves local fields the incoming row says nothing about', () => {
    const merged = mergeByField(
      { values: { title: 'mine', note: 'kept' }, stamps: { title: T1, note: T1 } },
      { values: { title: 'theirs' }, stamps: { title: T2 } },
    );
    expect(merged.values['note']).toBe('kept');
  });
});

describe('stampAll', () => {
  it('stamps every field from one write', () => {
    expect(stampAll({ a: 1, b: 2 }, T1)).toEqual({ a: T1, b: T1 });
  });
});

describe('Presence', () => {
  const entry = (clientId: string, cardId: string | null = null) => ({
    clientId,
    actorId: `actor-${clientId}`,
    displayName: clientId,
    cardId,
  });

  it('lists who is here', () => {
    const presence = new Presence();
    presence.seen(entry('ada'), 1000);
    presence.seen(entry('bob'), 1000);
    expect(presence.list(1000).map((row) => row.displayName)).toEqual(['ada', 'bob']);
  });

  it('drops a client that stopped heartbeating', () => {
    // A presence list that lies is worse than none, because people act on it —
    // they wait, or they avoid a card somebody left an hour ago.
    const presence = new Presence();
    presence.seen(entry('ghost'), 0);
    expect(presence.list(PRESENCE_TTL_MS + 1)).toEqual([]);
  });

  it('expires on read rather than on a timer', () => {
    // A timer that stops — suspended process, blocked event loop — leaves a
    // list that looks current and is not. Expiring on read cannot drift.
    const presence = new Presence();
    presence.seen(entry('ghost'), 0);
    expect(presence.size).toBe(1);
    presence.list(PRESENCE_TTL_MS + 1);
    expect(presence.size).toBe(0);
  });

  it('keeps a client alive while it keeps heartbeating', () => {
    const presence = new Presence();
    presence.seen(entry('ada'), 0);
    presence.seen(entry('ada'), PRESENCE_TTL_MS - 1);
    expect(presence.list(PRESENCE_TTL_MS)).toHaveLength(1);
  });

  it('answers who is on one card', () => {
    const presence = new Presence();
    presence.seen(entry('ada', 'FEAT-1'), 0);
    presence.seen(entry('bob', 'FEAT-2'), 0);
    expect(presence.on('FEAT-1', 0).map((row) => row.displayName)).toEqual(['ada']);
  });

  it('forgets a client that disconnected, without waiting for the TTL', () => {
    const presence = new Presence();
    presence.seen(entry('ada'), 0);
    presence.leave('ada');
    expect(presence.list(0)).toEqual([]);
  });

  it('exposes no way to persist itself', () => {
    // The point of the class. Presence that could be persisted eventually would
    // be, and then a stale row would outlive the person it describes.
    const methods = Object.getOwnPropertyNames(Presence.prototype);
    expect(methods).not.toContain('save');
    expect(methods).not.toContain('load');
    expect(methods.sort()).toEqual(['constructor', 'leave', 'list', 'on', 'seen', 'size']);
  });
});

/**
 * Collapsing connections into people (P4-COLLAB-01).
 *
 * `list()` answers per connection because that is what a socket server can
 * track. Every reader of that list means "who is here", and the gap between the
 * two is one person with two tabs appearing as two people.
 */
describe('viewers', () => {
  const entry = (over: Partial<PresenceEntry> = {}): PresenceEntry => ({
    clientId: 'c1',
    actorId: 'ana',
    displayName: 'Ana',
    cardId: null,
    seenAt: 1_000,
    ...over,
  });

  it('counts one person with two tabs once', () => {
    const result = viewers([entry({ clientId: 'c1' }), entry({ clientId: 'c2' })]);
    expect(result).toHaveLength(1);
    expect(result[0]?.connections).toBe(2);
  });

  it('unions the cards an actor has open across connections', () => {
    const result = viewers([
      entry({ clientId: 'c1', cardId: 'B' }),
      entry({ clientId: 'c2', cardId: 'A' }),
      entry({ clientId: 'c3', cardId: 'A' }),
    ]);
    expect(result[0]?.cardIds).toEqual(['A', 'B']);
  });

  it('reports the freshest heartbeat across an actor’s connections', () => {
    const result = viewers([
      entry({ clientId: 'c1', seenAt: 1_000 }),
      entry({ clientId: 'c2', seenAt: 9_000 }),
    ]);
    expect(result[0]?.seenAt).toBe(9_000);
  });

  it('keeps unidentified clients apart rather than merging them', () => {
    // Two anonymous clients are two different unknown people. Merging them on a
    // shared display name would hide one behind the other.
    const result = viewers([
      entry({ clientId: 'c1', actorId: null, displayName: 'someone' }),
      entry({ clientId: 'c2', actorId: null, displayName: 'someone' }),
    ]);
    expect(result).toHaveLength(2);
  });

  it('separates two different actors', () => {
    const result = viewers([
      entry({ clientId: 'c1', actorId: 'ana', displayName: 'Ana' }),
      entry({ clientId: 'c2', actorId: 'bo', displayName: 'Bo' }),
    ]);
    expect(result.map((v) => v.actorId)).toEqual(['ana', 'bo']);
  });

  it('orders stably so avatars do not reshuffle when a tab reconnects', () => {
    const result = viewers([
      entry({ clientId: 'c1', actorId: 'zoe', displayName: 'Zoe' }),
      entry({ clientId: 'c2', actorId: 'ana', displayName: 'Ana' }),
    ]);
    expect(result.map((v) => v.displayName)).toEqual(['Ana', 'Zoe']);
  });

  it('is empty for an empty list rather than throwing', () => {
    expect(viewers([])).toEqual([]);
  });
});
