import { describe, expect, it } from 'vitest';
import type { ChangeEvent } from '@sdlc-on-fire/core';
import { FanOut, type Client } from './fanout.js';

/**
 * P3-RT-01 — routing, without a socket.
 *
 * The server tests cover this end to end, but only along the paths a real
 * connection takes. The rules that matter on their own — what an absent filter
 * means, and what happens to a client whose send fails — are cheaper and
 * sharper to state here.
 */

const event = (over: Partial<ChangeEvent> = {}): ChangeEvent => ({
  table: 'work_items',
  id: 'A-1',
  op: 'UPDATE',
  updated_at: '2026-08-22T00:00:00Z',
  ...over,
});

function recorder(id: string, subscription = {}): Client & { got: ChangeEvent[] } {
  const got: ChangeEvent[] = [];
  return {
    id,
    subscription,
    got,
    send(next) {
      got.push(next);
    },
  };
}

describe('FanOut', () => {
  it('treats an absent filter as everything, not as nothing', () => {
    // The opposite default would make a client that connected without
    // subscribing receive silence, which reads as a dead connection rather
    // than as a filter doing its job.
    const fanout = new FanOut();
    const client = recorder('c1');
    fanout.add(client);

    fanout.deliver(event());
    fanout.deliver(event({ table: 'runs', id: 'r1' }));
    expect(client.got).toHaveLength(2);
  });

  it('filters by table and by id, and requires both to match', () => {
    const fanout = new FanOut();
    const client = recorder('c1', { tables: ['runs'], ids: ['r1'] });
    fanout.add(client);

    fanout.deliver(event({ table: 'runs', id: 'r1' }));
    fanout.deliver(event({ table: 'runs', id: 'r2' })); // right table, wrong id
    fanout.deliver(event({ table: 'work_items', id: 'r1' })); // right id, wrong table
    expect(client.got.map((got) => `${got.table}/${got.id}`)).toEqual(['runs/r1']);
  });

  it('treats an empty list the same as an absent one', () => {
    // `{ tables: [] }` is what a client sends when it clears its filter. Reading
    // it as "match nothing" would silently mute them.
    const fanout = new FanOut();
    const client = recorder('c1', { tables: [], ids: [] });
    fanout.add(client);
    fanout.deliver(event());
    expect(client.got).toHaveLength(1);
  });

  it('drops a client whose send throws, rather than retrying it forever', () => {
    // A socket that has failed once fails for every later event. Keeping it
    // would turn one dead connection into a permanent per-event exception.
    const fanout = new FanOut();
    fanout.add({
      id: 'broken',
      subscription: {},
      send() {
        throw new Error('socket is gone');
      },
    });
    const healthy = recorder('healthy');
    fanout.add(healthy);

    const first = fanout.deliver(event());
    expect(first.failed).toBe(1);
    expect(first.delivered).toBe(1);
    expect(fanout.size).toBe(1);

    const second = fanout.deliver(event());
    expect(second.failed).toBe(0);
    expect(healthy.got).toHaveLength(2);
  });

  it('changes what a connected client hears without reconnecting it', () => {
    const fanout = new FanOut();
    const client = recorder('c1', { tables: ['work_items'] });
    fanout.add(client);

    fanout.deliver(event({ table: 'runs' }));
    expect(client.got).toHaveLength(0);

    expect(fanout.resubscribe('c1', { tables: ['runs'] })).toBe(true);
    fanout.deliver(event({ table: 'runs' }));
    expect(client.got).toHaveLength(1);
  });

  it('reports a resubscribe for a client it does not have', () => {
    expect(new FanOut().resubscribe('ghost', {})).toBe(false);
  });

  it('counts skipped separately from delivered', () => {
    const fanout = new FanOut();
    fanout.add(recorder('a', { tables: ['runs'] }));
    fanout.add(recorder('b', { tables: ['work_items'] }));
    const stats = fanout.deliver(event({ table: 'work_items' }));
    expect(stats).toEqual({ delivered: 1, skipped: 1, failed: 0 });
  });

  it('forgets a removed client', () => {
    const fanout = new FanOut();
    const client = recorder('c1');
    fanout.add(client);
    fanout.remove('c1');
    fanout.deliver(event());
    expect(client.got).toHaveLength(0);
    expect(fanout.size).toBe(0);
  });
});
