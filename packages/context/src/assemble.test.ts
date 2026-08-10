import { ContextPackSpecSchema, type ContextPackSpec } from '@sdlc-on-fire/core';
import { describe, expect, it } from 'vitest';
import {
  assembleContextPack,
  BudgetTooSmallError,
  estimateTokens,
  renderPack,
  stablePrefix,
} from './assemble.js';
import { chunkText, toSearchQuery } from './retrieval.js';

function spec(max = 1000): ContextPackSpec {
  return ContextPackSpecSchema.parse({
    skillId: 'implement',
    stageId: 'implement',
    budget: { max },
    sources: { include: [{ kind: 'work_item', id: 'TASK-001' }] },
    freshness: { revalidateOnAssembly: true },
    isolation: 'fresh-subagent',
    disposer: 'assembleContextPack.truncateToBudget',
  });
}

const base = {
  cardId: 'TASK-001',
  skillStable: 'You are the Implementer.',
  cardCore: 'Implement CSV export.',
  packId: '3f1b7c22-9a4e-4a3e-8f2b-2c4a1d5e6f70',
  now: new Date('2026-08-10T00:00:00.000Z'),
};

describe('layer ordering', () => {
  it('emits stable-prefix-first', async () => {
    const { pack: pack } = await assembleContextPack({
      spec: spec(),
      ...base,
      rollingState: 'prior state',
    });
    expect(pack.layers.map((l) => l.kind)).toEqual(['skill-stable', 'rolling-state', 'card-core']);
  });

  it('omits absent layers rather than emitting empty ones', async () => {
    const { pack: pack } = await assembleContextPack({ spec: spec(), ...base });
    expect(pack.layers.map((l) => l.kind)).toEqual(['skill-stable', 'card-core']);
  });

  it('renders layers in array order', async () => {
    const { pack: pack } = await assembleContextPack({ spec: spec(), ...base });
    expect(renderPack(pack).indexOf('Implementer')).toBeLessThan(renderPack(pack).indexOf('CSV'));
  });
});

describe('cache boundary', () => {
  it('marks the stable prefix', async () => {
    const { pack: pack } = await assembleContextPack({ spec: spec(), ...base });
    expect(pack.stableUpToIndex).toBe(0);
    expect(stablePrefix(pack)).toBe('You are the Implementer.');
  });

  it('never extends past a volatile layer', async () => {
    const { pack: pack } = await assembleContextPack({
      spec: spec(),
      ...base,
      rollingState: 'volatile',
    });
    expect(pack.layers[pack.stableUpToIndex]?.kind).toBe('skill-stable');
  });

  it('is byte-identical across invocations with different cards', async () => {
    const { pack: a } = await assembleContextPack({ spec: spec(), ...base });
    const { pack: b } = await assembleContextPack({
      ...base,
      spec: spec(),
      cardId: 'TASK-999',
      cardCore: 'Different work.',
    });
    expect(stablePrefix(a)).toBe(stablePrefix(b));
  });
});

describe('budget enforcement', () => {
  it('keeps totalTokens within budget', async () => {
    const { pack: pack } = await assembleContextPack({
      spec: spec(60),
      ...base,
      rollingState: 'x'.repeat(400),
    });
    expect(pack.totalTokens).toBeLessThanOrEqual(60);
  });

  it('drops retrieval before optional layers', async () => {
    const { pack: pack } = await assembleContextPack({
      spec: spec(40),
      ...base,
      rollingState: 'y'.repeat(200),
      retrieve: () => Promise.resolve([{ id: 'c1', text: 'z'.repeat(400), score: 1, tokens: 100 }]),
    });
    expect(pack.layers.map((l) => l.kind)).not.toContain('retrieval');
  });

  it('never truncates card-core', async () => {
    // An agent given a partial task will confidently do the wrong thing.
    const { pack: pack } = await assembleContextPack({
      spec: spec(40),
      ...base,
      rollingState: 'y'.repeat(800),
    });
    expect(pack.layers.some((l) => l.kind === 'card-core')).toBe(true);
    expect(pack.layers.find((l) => l.kind === 'card-core')?.content).toBe(base.cardCore);
  });

  it('fails loudly when card-core alone exceeds the budget', async () => {
    await expect(
      assembleContextPack({ spec: spec(2), ...base, cardCore: 'w'.repeat(400) }),
    ).rejects.toBeInstanceOf(BudgetTooSmallError);
  });

  it('honours the low tier when set', async () => {
    const lowSpec = ContextPackSpecSchema.parse({ ...spec(1000), budget: { max: 1000, low: 30 } });
    const { pack: pack } = await assembleContextPack({
      spec: lowSpec,
      ...base,
      effortTier: 'low',
      rollingState: 'y'.repeat(600),
    });
    expect(pack.totalTokens).toBeLessThanOrEqual(30);
  });
});

describe('retrieval', () => {
  it('includes chunks that fit, highest score first', async () => {
    const { pack: pack } = await assembleContextPack({
      spec: spec(1000),
      ...base,
      retrieve: () =>
        Promise.resolve([
          { id: 'low', text: 'LOW', score: 0.1, tokens: 5 },
          { id: 'high', text: 'HIGH', score: 0.9, tokens: 5 },
        ]),
    });
    const retrieval = pack.layers.find((l) => l.kind === 'retrieval')?.content ?? '';
    expect(retrieval.indexOf('HIGH')).toBeLessThan(retrieval.indexOf('LOW'));
  });

  it('works with no retriever at all', async () => {
    const { pack: pack } = await assembleContextPack({ spec: spec(), ...base });
    expect(pack.layers.some((l) => l.kind === 'retrieval')).toBe(false);
  });
});

describe('helpers', () => {
  it('estimates tokens monotonically', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('a'.repeat(400))).toBeGreaterThan(estimateTokens('a'.repeat(40)));
  });

  it('strips punctuation and ORs the terms', () => {
    // Updated with the A-03 fix: the output is a `to_tsquery` OR expression, not
    // a word list. The old assertion passed against a retriever that returned
    // nothing for every realistic query, because `websearch_to_tsquery` ANDs.
    expect(toSearchQuery('Add CSV export (v2)!')).toBe('add | csv | export | v2');
  });

  it('returns an empty query for punctuation-only text', () => {
    expect(toSearchQuery('!!! ???')).toBe('');
  });

  it('chunks on paragraph boundaries', () => {
    const chunks = chunkText('a'.repeat(800) + '\n\n' + 'b'.repeat(800), 1000);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.startsWith('a')).toBe(true);
  });

  it('keeps short text as one chunk', () => {
    expect(chunkText('short')).toEqual(['short']);
  });
});
