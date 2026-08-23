import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { init } from './commands.js';
import {
  loadRelevanceSet,
  MissingRelevanceSet,
  RELEVANCE_PATH,
  retrievalReport,
} from './retrieval-eval-run.js';

/**
 * The relevance set, and what happens without one (P6-INSTRUMENT-01).
 *
 * Against a real workspace: the file's location is part of the contract — it has
 * to be visible, git-tracked content that survives `db:rebuild`, and a mock
 * would only prove the mock agrees with my model of where it goes.
 */
const dirs: string[] = [];
const RM_RETRY = { maxRetries: 5, retryDelay: 100 } as const;

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true, ...RM_RETRY }).catch(() => undefined);
  }
});

async function workspace(): Promise<string> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sdlcof-reteval-')));
  dirs.push(root);
  await init(root, { database: 'skip' });
  return root;
}

const SET = [
  'schema_version: 0.1.0',
  'held_out: true',
  'judgements:',
  '  - query: how do gates block an advance',
  '    relevant:',
  '      - docs a 0',
  '    judged_by: farasat',
  '    judged_on: 2026-08-24',
  '',
].join('\n');

async function writeSet(root: string, body: string): Promise<void> {
  const where = path.join(root, RELEVANCE_PATH);
  await fs.mkdir(path.dirname(where), { recursive: true });
  await fs.writeFile(where, body, 'utf8');
}

describe('the relevance set', () => {
  it('refuses to report a number without one', async () => {
    // An empty or defaulted set scores every retriever identically and reports
    // it as a measurement, which is worse than reporting nothing.
    const root = await workspace();
    await expect(retrievalReport(root)).rejects.toBeInstanceOf(MissingRelevanceSet);
  }, 90_000);

  it('says what to create, not just that something is missing', async () => {
    const root = await workspace();
    await expect(retrievalReport(root)).rejects.toThrow(/held_out: true/);
  }, 90_000);

  it('loads a well-formed set from the visible docs tree', async () => {
    // Under `docs/`, like gate policies: hand-edited, diffed and argued about in
    // review, so it cannot live under the gitignored state directory.
    const root = await workspace();
    await writeSet(root, SET);
    const set = await loadRelevanceSet(root);
    expect(set.judgements).toHaveLength(1);
    expect(set.judgements[0]?.judged_by).toBe('farasat');
  }, 90_000);

  it('refuses a set that does not declare itself held out', async () => {
    const root = await workspace();
    await writeSet(root, SET.replace('held_out: true', 'held_out: false'));
    await expect(loadRelevanceSet(root)).rejects.toThrow();
  }, 90_000);

  it('refuses a judgement nobody signed', async () => {
    const root = await workspace();
    await writeSet(root, SET.replace('    judged_by: farasat\n', ''));
    await expect(loadRelevanceSet(root)).rejects.toThrow();
  }, 90_000);
});
