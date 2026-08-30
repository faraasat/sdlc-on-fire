import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { init } from './commands.js';
import {
  CORPUS_FILE,
  formatSnapshot,
  formatVisibilityTrend,
  snapshotVisibility,
  visibilityTrendFor,
} from './visibility.js';

/**
 * Visibility over time against real PGlite (P7-VISIBILITY-01, ADR-0074).
 *
 * The claim that matters is the one about restraint: a trend built on point
 * estimates reports movement on noise, and this one refuses to.
 */

const RM_RETRY = { maxRetries: 5, retryDelay: 100 } as const;
const SUBJECT = 'SDLC on Fire';
const HOST = 'sdlc-on-fire.dev';
let root: string;

/** A corpus where `mentionHits` of `attempts` answers mention the subject. */
async function writeCorpus(mentionHits: number, attempts: number, valid = true): Promise<void> {
  const responses = Array.from({ length: attempts }, (_, i) => ({
    cell: { prompt: 'q1', paraphrase: 0, engine: 'openai', repeat: i },
    text: i < mentionHits ? `You could use ${SUBJECT} for that.` : 'Try something else.',
    citations: [],
    at: '2026-08-30T00:00:00.000Z',
  }));

  await fs.mkdir(path.join(root, '.sdlcof'), { recursive: true });
  await fs.writeFile(
    path.join(root, '.sdlcof', CORPUS_FILE),
    JSON.stringify({
      spec: {
        prompts: valid
          ? [{ id: 'q1', paraphrases: ['what tool for this', 'recommend a tool'] }]
          : [],
        engines: ['openai'],
        repeats: 3,
      },
      responses,
      startedAt: '2026-08-30T00:00:00.000Z',
      finishedAt: '2026-08-30T00:10:00.000Z',
    }),
    'utf8',
  );
}

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'viz-')));
  await init(root, { database: 'skip' });
}, 180_000);

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true, ...RM_RETRY });
});

describe('recording a snapshot', () => {
  it('refuses when there is no corpus at all', async () => {
    const result = await snapshotVisibility(root, SUBJECT, HOST);
    expect(result.recorded).toBe(false);
    expect(result.problems[0]).toContain('nothing to snapshot');
  }, 180_000);

  it('refuses a corpus whose matrix cannot support its own claim', async () => {
    // Still worth *reading* — `sdlc visibility` shows it — but recording it
    // would launder a bad run into a data point.
    await writeCorpus(10, 20, false);
    const result = await snapshotVisibility(root, SUBJECT, HOST);
    expect(result.recorded).toBe(false);
    expect(formatSnapshot(result)).toContain('launder');
  }, 180_000);

  it('records a valid corpus', async () => {
    await writeCorpus(10, 40);
    const result = await snapshotVisibility(root, SUBJECT, HOST, {
      ranAt: '2026-08-01T00:00:00.000Z',
    });
    expect(result.recorded).toBe(true);
  }, 180_000);

  it('records one snapshot per (subject, time)', async () => {
    await writeCorpus(10, 40);
    await snapshotVisibility(root, SUBJECT, HOST, { ranAt: '2026-08-01T00:00:00.000Z' });
    const second = await snapshotVisibility(root, SUBJECT, HOST, {
      ranAt: '2026-08-01T00:00:00.000Z',
    });
    expect(second.recorded).toBe(false);
  }, 180_000);
});

describe('the trend', () => {
  it('is unmeasured before two runs', async () => {
    await writeCorpus(10, 40);
    await snapshotVisibility(root, SUBJECT, HOST, { ranAt: '2026-08-01T00:00:00.000Z' });
    const trend = await visibilityTrendFor(root, SUBJECT);
    expect(trend.snapshots).toBe(1);
    expect(trend.moved).toEqual([]);
  }, 180_000);

  it('declines to call a small move a change', async () => {
    await writeCorpus(20, 40);
    await snapshotVisibility(root, SUBJECT, HOST, { ranAt: '2026-08-01T00:00:00.000Z' });
    await writeCorpus(22, 40);
    await snapshotVisibility(root, SUBJECT, HOST, { ranAt: '2026-08-08T00:00:00.000Z' });

    const trend = await visibilityTrendFor(root, SUBJECT);
    expect(trend.snapshots).toBe(2);
    expect(trend.moved).toEqual([]);
    expect(trend.levels.find((l) => l.level === 'mention')?.verdict).toBe('indistinguishable');
  }, 180_000);

  it('reports a move the sample actually supports', async () => {
    await writeCorpus(2, 100);
    await snapshotVisibility(root, SUBJECT, HOST, { ranAt: '2026-08-01T00:00:00.000Z' });
    await writeCorpus(90, 100);
    await snapshotVisibility(root, SUBJECT, HOST, { ranAt: '2026-08-08T00:00:00.000Z' });

    const trend = await visibilityTrendFor(root, SUBJECT);
    expect(trend.moved).toContain('mention');
    expect(trend.levels.find((l) => l.level === 'mention')?.verdict).toBe('improved');
  }, 180_000);

  it('recomputes intervals from the stored counts', async () => {
    // Stored counts and a stored interval can disagree; recomputing makes that
    // impossible, and the counts are what a Wilson interval needs anyway.
    await writeCorpus(10, 40);
    await snapshotVisibility(root, SUBJECT, HOST, { ranAt: '2026-08-01T00:00:00.000Z' });
    await writeCorpus(12, 40);
    await snapshotVisibility(root, SUBJECT, HOST, { ranAt: '2026-08-08T00:00:00.000Z' });

    const trend = await visibilityTrendFor(root, SUBJECT);
    const mention = trend.levels.find((l) => l.level === 'mention');
    expect(mention?.first?.hits).toBe(10);
    expect(mention?.first?.attempts).toBe(40);
    expect(mention?.first?.low).toBeGreaterThan(0);
    expect(mention?.first?.high).toBeLessThan(1);
    expect(formatVisibilityTrend(trend)).toContain('(10/40)');
  }, 180_000);

  it('keeps subjects apart', async () => {
    await writeCorpus(10, 40);
    await snapshotVisibility(root, SUBJECT, HOST, { ranAt: '2026-08-01T00:00:00.000Z' });
    expect((await visibilityTrendFor(root, 'Something Else')).snapshots).toBe(0);
  }, 180_000);
});
