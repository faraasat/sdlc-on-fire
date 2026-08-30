import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StageHandoffSchema, type StageHandoff } from '@sdlc-on-fire/core';
import {
  acceptHandoff,
  handoffDir,
  readHandoff,
  readHandoffChain,
  writeHandoff,
} from './handoff.js';

/** Real files in a real temp directory — the writer's whole job is what lands on disk. */
let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'sdlcof-handoff-'));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function handoff(overrides: Partial<StageHandoff> = {}): StageHandoff {
  return StageHandoffSchema.parse({
    schema_version: '1',
    runId: 'run-7',
    workItemId: 'WI-3',
    from: 'plan',
    to: 'implement',
    openQuestions: [],
    ...overrides,
  });
}

describe('acceptHandoff', () => {
  it('reports a shape problem with the offending path', () => {
    const result = acceptHandoff({ schema_version: '1', runId: 'run-7' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.reason).toBe('invalid-shape');
    expect(result.rejection.detail).toContain('workItemId');
  });

  it('separates a structural problem from a shape problem', () => {
    const previous = handoff({ from: 'spec', to: 'plan', openQuestions: ['what about CSV?'] });
    const result = acceptHandoff(handoff(), previous);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // The object is perfectly valid; what is wrong is its relationship to the
    // one before it. Collapsing these two reasons would send a caller to fix
    // the wrong thing.
    expect(result.rejection.reason).toBe('structural');
    expect(result.rejection.detail).toContain('CSV');
  });

  it('is a returned value, not a thrown error', () => {
    expect(() => acceptHandoff('not a handoff at all')).not.toThrow();
  });
});

describe('writeHandoff / readHandoff', () => {
  it('round-trips through a real file', async () => {
    const original = handoff({
      decisions: [{ statement: 'use PGlite', because: 'no server to install' }],
      openQuestions: ['do we need a migration for this?'],
      artifacts: ['packages/db/src/schema.ts'],
      requiredInputs: ['the migration file'],
    });
    const file = await writeHandoff(root, original);
    expect(file.startsWith(handoffDir(root, 'run-7'))).toBe(true);

    const loaded = await readHandoff(root, 'run-7', 'plan', 'implement');
    expect(loaded).toEqual(original);
  });

  it('refuses to write a handoff that does not cross a boundary', async () => {
    await expect(writeHandoff(root, handoff({ from: 'plan', to: 'plan' }))).rejects.toThrow(
      /invalid handoff/,
    );
    // And nothing was left behind on disk for a later read to trust.
    await expect(fs.readdir(handoffDir(root, 'run-7'))).rejects.toThrow();
  });

  it('returns null for a boundary that has not been crossed', async () => {
    expect(await readHandoff(root, 'run-7', 'plan', 'implement')).toBeNull();
  });

  it('throws on a corrupt handoff rather than reporting it absent', async () => {
    const dir = handoffDir(root, 'run-7');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'plan--implement.json'), '{"schema_version":"9"}', 'utf8');
    // "Absent" would let the next stage proceed as though nothing came before.
    await expect(readHandoff(root, 'run-7', 'plan', 'implement')).rejects.toThrow(/not a valid/);
  });
});

describe('readHandoffChain', () => {
  it('orders by stage links, not by filename', async () => {
    // Written out of order, and alphabetically the reverse of chronological:
    // "approval--done" sorts before "implement--test".
    await writeHandoff(root, handoff({ from: 'implement', to: 'test' }));
    await writeHandoff(root, handoff({ from: 'approval', to: 'done' }));
    await writeHandoff(root, handoff({ from: 'spec', to: 'plan' }));
    await writeHandoff(root, handoff({ from: 'plan', to: 'implement' }));
    await writeHandoff(root, handoff({ from: 'test', to: 'review' }));
    await writeHandoff(root, handoff({ from: 'review', to: 'approval' }));

    const chain = await readHandoffChain(root, 'run-7');
    expect(chain.map((entry) => entry.from)).toEqual([
      'spec',
      'plan',
      'implement',
      'test',
      'review',
      'approval',
    ]);
  });

  it('still reports a handoff that does not connect to the chain', async () => {
    await writeHandoff(root, handoff({ from: 'spec', to: 'plan' }));
    await writeHandoff(root, handoff({ from: 'review', to: 'approval' }));
    const chain = await readHandoffChain(root, 'run-7');
    expect(chain).toHaveLength(2);
  });

  it('returns nothing for a run with no handoffs', async () => {
    expect(await readHandoffChain(root, 'no-such-run')).toEqual([]);
  });
});

describe('the size cap at the boundary (P8-EVID-03)', () => {
  it('rejects an over-cap handoff rather than writing a truncated one', () => {
    const result = acceptHandoff(handoff({ notes: 'n'.repeat(12_000) }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.reason).toBe('over-cap');
  });

  it('hands back the reprompt as the detail, so nothing has to compose one', () => {
    const result = acceptHandoff(handoff({ notes: 'n'.repeat(12_000) }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.detail).toContain('Shorten in this order');
    expect(result.rejection.detail).toContain('Never drop openQuestions');
  });

  it('refuses to write one to disk — the file is what the next stage reads', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'handoff-cap-'));
    try {
      await expect(writeHandoff(dir, handoff({ notes: 'n'.repeat(12_000) }))).rejects.toThrow(
        /refusing to write/,
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('still accepts an ordinary handoff', () => {
    expect(acceptHandoff(handoff({ notes: 'a short note' })).ok).toBe(true);
  });
});
