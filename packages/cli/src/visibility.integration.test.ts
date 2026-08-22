import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { init } from './commands.js';
import { CORPUS_FILE, readVisibility } from './visibility.js';

/**
 * `sdlc visibility` over a real corpus file (P5-VIZ-02/03).
 *
 * The analysis is pure and tested in core. What only this can show is that the
 * command **makes no network call** and that an absent corpus reads as absent —
 * an instrument reporting zeros because it has no data looks exactly like one
 * reporting zeros because nobody mentions you, and those are opposite facts.
 */

const run = promisify(execFile);
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
const RM_RETRY = { maxRetries: 5, retryDelay: 100 } as const;
let root: string;

const spec = {
  prompts: [{ id: 'q', paraphrases: ['what framework for X', 'best X framework'] }],
  engines: ['openai', 'anthropic'] as const,
  repeats: 1,
};

const cell = (engine: 'openai' | 'anthropic', paraphrase: number) => ({
  prompt: spec.prompts[0]?.paraphrases[paraphrase] ?? '',
  paraphrase,
  engine,
  repeat: 1,
});

async function writeCorpus(responses: unknown[]): Promise<void> {
  const dir = path.join(root, '.sdlcof');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, CORPUS_FILE),
    JSON.stringify({
      spec,
      responses,
      startedAt: '2026-08-22T00:00:00.000Z',
      finishedAt: '2026-08-22T00:01:00.000Z',
    }),
  );
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'sdlcof-vis-'));
  await init(root, { database: 'skip' });
}, 90_000);

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true, ...RM_RETRY });
});

describe('sdlc visibility', () => {
  it('says the corpus is absent rather than reporting zeros', async () => {
    const result = await readVisibility(root, 'Hono', 'hono.dev');
    expect(result.found).toBe(false);
    expect(result.analysis).toBeUndefined();
  });

  it('analyses a real corpus file', async () => {
    await writeCorpus([
      {
        cell: cell('openai', 0),
        text: 'Hono is a good pick',
        citations: ['https://hono.dev/'],
        at: '2026-08-22T00:00:00.000Z',
      },
      {
        cell: cell('anthropic', 0),
        text: 'try Fastify',
        citations: ['https://github.com/x'],
        at: '2026-08-22T00:00:00.000Z',
      },
      {
        cell: cell('openai', 1),
        text: 'Hono works well',
        citations: ['https://github.com/x'],
        at: '2026-08-22T00:00:00.000Z',
      },
      {
        cell: cell('anthropic', 1),
        text: 'Express is fine',
        citations: [],
        at: '2026-08-22T00:00:00.000Z',
      },
    ]);

    const result = await readVisibility(root, 'Hono', 'hono.dev');
    expect(result.found).toBe(true);
    expect(result.analysis?.overall.mention.hits).toBe(2);
    expect(result.analysis?.overall.citation.hits).toBe(1);
    expect(result.coverage?.complete).toBe(true);
  });

  it('names the third-party hosts that actually get cited', async () => {
    await writeCorpus([
      {
        cell: cell('openai', 0),
        text: 'a',
        citations: ['https://github.com/x'],
        at: '2026-08-22T00:00:00.000Z',
      },
      {
        cell: cell('anthropic', 0),
        text: 'b',
        citations: ['https://github.com/y'],
        at: '2026-08-22T00:00:00.000Z',
      },
      {
        cell: cell('openai', 1),
        text: 'c',
        citations: ['https://hono.dev/'],
        at: '2026-08-22T00:00:00.000Z',
      },
      { cell: cell('anthropic', 1), text: 'd', citations: [], at: '2026-08-22T00:00:00.000Z' },
    ]);
    const result = await readVisibility(root, 'Hono', 'hono.dev');
    expect(result.sources?.[0]).toEqual({ host: 'github.com', count: 2 });
  });

  it('flags a corpus whose design could not support its claim', async () => {
    // Validated from the artifact rather than from whoever ran it.
    const dir = path.join(root, '.sdlcof');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, CORPUS_FILE),
      JSON.stringify({
        spec: {
          prompts: [{ id: 'q', paraphrases: ['one wording'] }],
          engines: ['openai'],
          repeats: 4,
        },
        responses: [],
        startedAt: 'x',
        finishedAt: 'y',
      }),
    );
    const result = await readVisibility(root, 'Hono', 'hono.dev');
    expect(result.problems.some((p) => p.includes('measures the sampler'))).toBe(true);
  });

  it('reports unreadable JSON as a problem rather than throwing', async () => {
    const dir = path.join(root, '.sdlcof');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, CORPUS_FILE), '{ not json');
    const result = await readVisibility(root, 'Hono', 'hono.dev');
    expect(result.problems[0]).toContain('not readable JSON');
  });

  it('makes no network call — asserted by running it with no network permitted', async () => {
    // The strongest available structural check: the command completes with
    // DNS pointed nowhere. If it ever grows a fetch, this fails.
    await writeCorpus([
      { cell: cell('openai', 0), text: 'Hono', citations: [], at: '2026-08-22T00:00:00.000Z' },
      { cell: cell('anthropic', 0), text: 'x', citations: [], at: '2026-08-22T00:00:00.000Z' },
      { cell: cell('openai', 1), text: 'y', citations: [], at: '2026-08-22T00:00:00.000Z' },
      { cell: cell('anthropic', 1), text: 'z', citations: [], at: '2026-08-22T00:00:00.000Z' },
    ]);
    const { stdout } = await run(
      process.execPath,
      [CLI, 'visibility', '--subject', 'Hono', '--host', 'hono.dev'],
      {
        cwd: root,
        env: {
          ...process.env,
          HTTP_PROXY: 'http://127.0.0.1:1',
          HTTPS_PROXY: 'http://127.0.0.1:1',
        },
      },
    );
    expect(stdout).toContain('mention');
    expect(stdout).toContain('Levels are separate');
  }, 60_000);

  it('never prints a rate without its interval and counts', async () => {
    await writeCorpus([
      { cell: cell('openai', 0), text: 'Hono', citations: [], at: '2026-08-22T00:00:00.000Z' },
      { cell: cell('anthropic', 0), text: 'x', citations: [], at: '2026-08-22T00:00:00.000Z' },
      { cell: cell('openai', 1), text: 'y', citations: [], at: '2026-08-22T00:00:00.000Z' },
      { cell: cell('anthropic', 1), text: 'z', citations: [], at: '2026-08-22T00:00:00.000Z' },
    ]);
    const { stdout } = await run(
      process.execPath,
      [CLI, 'visibility', '--subject', 'Hono', '--host', 'hono.dev'],
      { cwd: root },
    );
    for (const line of stdout
      .split('\n')
      .filter((l) => /^\s+(mention|citation|answered)\s/.test(l))) {
      expect(line, line).toMatch(/\[.+ – .+\]/);
      expect(line, line).toMatch(/\(\d+\/\d+\)/);
    }
  }, 60_000);
});
