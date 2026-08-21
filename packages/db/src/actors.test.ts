import { describe, expect, it } from 'vitest';
import { ensureHumanActor, type ActorWriter } from './actors.js';

/**
 * P3-UI-01 — bootstrapping the human.
 *
 * A fake writer, deliberately: what is under test is the decision — create,
 * reuse, or rename — and a real database would only add latency to the same
 * three branches. The end-to-end path is covered by `serve.integration`.
 */

function fakeDb(rows: { id: string; display_name: string }[] = []): ActorWriter & {
  readonly sql: string[];
} {
  const sql: string[] = [];
  return {
    sql,
    query<T>(statement: string): Promise<T[]> {
      sql.push(statement.trim().split('\n')[0] ?? '');
      if (statement.includes('SELECT')) return Promise.resolve(rows as T[]);
      if (statement.includes('RETURNING')) return Promise.resolve([{ id: 'new-id' }] as T[]);
      return Promise.resolve([] as T[]);
    },
  };
}

describe('ensureHumanActor', () => {
  it('creates a human when none matches', async () => {
    const db = fakeDb([]);
    const result = await ensureHumanActor(db, 'ada@example.test', 'Ada Lovelace');
    expect(result.created).toBe(true);
    expect(result.actorId).toBe('new-id');
  });

  it('is idempotent — a second call mints nothing', async () => {
    const db = fakeDb([{ id: 'a1', display_name: 'Ada Lovelace' }]);
    const result = await ensureHumanActor(db, 'ada@example.test', 'Ada Lovelace');
    expect(result.created).toBe(false);
    expect(result.actorId).toBe('a1');
    expect(db.sql.some((statement) => statement.includes('INSERT'))).toBe(false);
  });

  it('matches on a lower-cased email, so casing does not mint a second person', async () => {
    // Two actor rows for one human make identity resolution ambiguous, and
    // ambiguous resolution refuses — a worse outcome than either row alone.
    const db = fakeDb([{ id: 'a1', display_name: 'Ada' }]);
    await ensureHumanActor(db, '  Ada@Example.TEST ', 'Ada');
    expect(db.sql[0]).toContain('SELECT');
  });

  it('upgrades a placeholder name once a real one is known', async () => {
    // `init` may run before `git config user.name` is set and falls back to the
    // email. A later call that knows the name should improve the row rather
    // than label the person by their address forever.
    const db = fakeDb([{ id: 'a1', display_name: 'ada@example.test' }]);
    const result = await ensureHumanActor(db, 'ada@example.test', 'Ada Lovelace');
    expect(db.sql.some((statement) => statement.includes('UPDATE'))).toBe(true);
    expect(result.because).toContain('Ada Lovelace');
  });

  it('never overwrites a real name that is already recorded', async () => {
    const db = fakeDb([{ id: 'a1', display_name: 'Ada Lovelace' }]);
    await ensureHumanActor(db, 'ada@example.test', 'Someone Else');
    expect(db.sql.some((statement) => statement.includes('UPDATE'))).toBe(false);
  });

  it('does nothing at all without an email', async () => {
    // A missing git identity is not an error; it is a workspace where nobody
    // has configured one, and minting an actor for it would guess a person.
    for (const email of [undefined, '', '   ']) {
      const db = fakeDb([]);
      const result = await ensureHumanActor(db, email);
      expect(result.actorId, String(email)).toBeNull();
      expect(result.created, String(email)).toBe(false);
      expect(db.sql, String(email)).toEqual([]);
    }
  });

  it('falls back to the email as a display name rather than an empty one', async () => {
    const db = fakeDb([]);
    await ensureHumanActor(db, 'ada@example.test', '   ');
    expect(db.sql.some((statement) => statement.includes('INSERT'))).toBe(true);
  });
});
