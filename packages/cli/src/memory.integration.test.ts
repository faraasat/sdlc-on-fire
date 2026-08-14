import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { init } from './commands.js';
import { listMemory, memoryHistory, recordMemory } from './memory.js';

/**
 * Teardown retries, because Windows keeps a file locked while anything holds it.
 *
 * A child process that has just exited can still own its handles for a moment,
 * and removing the directory then fails with EBUSY — which Vitest reports as a
 * failed suite even though every assertion in it passed. Retrying is the
 * documented remedy, and is a no-op on platforms without the problem.
 */
const RM_RETRY = { maxRetries: 5, retryDelay: 100 } as const;

/**
 * Typed memory end to end, against a real PGlite (P1-OBJ-04, ADR-0023).
 *
 * The pure resolution is argued with in `core/memory-entry.test.ts`. What is
 * checked here is that the decision is actually *applied*: that a correction
 * closes a window rather than overwriting a row, that the trail survives, and
 * that the whole thing is reachable from a command — because a memory store
 * nobody can read is one whose drift nobody notices.
 */

const run = promisify(execFile);
let root: string;

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'memory-')));
  await run('git', ['init', '-q'], { cwd: root });
  await init(root, { database: 'skip' });
}, 180_000);

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true, ...RM_RETRY });
});

const claim = (body: string, validFrom: string): Parameters<typeof recordMemory>[1] => ({
  type: 'semantic',
  title: 'CSV delimiter',
  body,
  source: 'user-authored',
  writtenBy: 'alice',
  validFrom,
});

describe('recording a belief', () => {
  it('records it, with its provenance', async () => {
    const result = await recordMemory(root, claim('A comma.', '2026-06-01T00:00:00.000Z'));
    expect(result.recorded).toBe(true);
    expect(result.entry?.source_type).toBe('user-authored');
    expect(result.entry?.written_by).toBe('alice');
  }, 180_000);

  it('refuses a source outside the vocabulary, and says why it matters', async () => {
    await expect(
      recordMemory(root, { ...claim('x', '2026-06-01T00:00:00.000Z'), source: 'somewhere' }),
    ).rejects.toThrow(/Provenance is required/);
  }, 180_000);

  it('declines to record the same claim twice', async () => {
    await recordMemory(root, claim('A comma.', '2026-06-01T00:00:00.000Z'));
    const again = await recordMemory(root, claim('A comma.', '2026-07-01T00:00:00.000Z'));

    expect(again.recorded).toBe(false);
    expect(again.reason).toMatch(/is not a correction/);
    expect((await listMemory(root)).entries).toHaveLength(1);
  }, 180_000);
});

describe('correcting a belief', () => {
  it('closes the old window instead of overwriting the row', async () => {
    await recordMemory(root, claim('A comma.', '2026-06-01T00:00:00.000Z'));
    await recordMemory(root, claim('A semicolon.', '2026-07-01T00:00:00.000Z'));

    // One current belief...
    const current = await listMemory(root);
    expect(current.entries).toHaveLength(1);
    expect(current.entries[0]?.body).toBe('A semicolon.');

    // ...and the old one still readable, with the window it held.
    const history = await memoryHistory(root, 'CSV delimiter');
    expect(history).toHaveLength(2);
    const superseded = history.find((entry) => entry.body === 'A comma.');
    expect(superseded?.conflict_status).toBe('superseded');
    expect(superseded?.valid_to).toContain('2026-07-01');
    expect(superseded?.superseded_by).toBe(current.entries[0]?.id);
  }, 180_000);

  it('keeps the windows abutting, so one date has one answer', async () => {
    await recordMemory(root, claim('A comma.', '2026-06-01T00:00:00.000Z'));
    await recordMemory(root, claim('A semicolon.', '2026-07-01T00:00:00.000Z'));

    const history = await memoryHistory(root, 'CSV delimiter');
    const first = history.find((entry) => entry.body === 'A comma.');
    const second = history.find((entry) => entry.body === 'A semicolon.');
    expect(first?.valid_to).toBe(second?.valid_from);
  }, 180_000);
});

describe('when neither claim can be ordered', () => {
  it('marks both contested rather than letting the later write win', async () => {
    // A fact recorded today can be about last month. "Most recent write wins"
    // would silently discard the older, possibly better-founded claim.
    await recordMemory(root, claim('A comma.', '2026-06-01T00:00:00.000Z'));
    const late = await recordMemory(root, claim('A tab all along.', '2026-05-01T00:00:00.000Z'));

    expect(late.entry?.conflict_status).toBe('contested');

    const current = await listMemory(root);
    // Both remain current — neither was retracted, which is the point.
    expect(current.entries).toHaveLength(2);
    expect(current.entries.every((entry) => entry.conflict_status === 'contested')).toBe(true);
  }, 180_000);
});

describe('reading it back', () => {
  it('filters by type, so a convention is not ranked against an observation', async () => {
    await recordMemory(root, claim('A comma.', '2026-06-01T00:00:00.000Z'));
    await recordMemory(root, {
      type: 'procedural',
      title: 'Running the suite',
      body: 'pnpm test, never npm test.',
      source: 'user-authored',
      writtenBy: 'alice',
    });

    expect((await listMemory(root, { type: 'procedural' })).entries).toHaveLength(1);
  }, 180_000);

  it('ranks by the formula, most salient first', async () => {
    await recordMemory(root, {
      type: 'semantic',
      title: 'Minor detail',
      body: 'x',
      source: 'user-authored',
      writtenBy: 'alice',
      importance: 0.1,
    });
    await recordMemory(root, {
      type: 'semantic',
      title: 'Load-bearing fact',
      body: 'y',
      source: 'user-authored',
      writtenBy: 'alice',
      importance: 0.9,
    });

    const listed = await listMemory(root);
    expect(listed.entries[0]?.title).toBe('Load-bearing fact');
  }, 180_000);

  it('says nothing rather than inventing something on an empty store', async () => {
    expect((await listMemory(root)).entries).toEqual([]);
    expect(await memoryHistory(root, 'anything')).toEqual([]);
  }, 180_000);
});
