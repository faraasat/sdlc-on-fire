import { describe, expect, it } from 'vitest';
import { decisionLog, researchIndex, type DocRow } from './doc-index.js';

const doc = (
  id: string,
  docType: string,
  metadata: Record<string, unknown> | null = {},
  over: Partial<DocRow> = {},
): DocRow => ({
  id,
  docType,
  filePath: `docs/${id}.md`,
  title: `Title of ${id}`,
  metadata,
  updatedAt: '2026-08-30T00:00:00.000Z',
  ...over,
});

describe('researchIndex', () => {
  it('is empty and says so', () => {
    const index = researchIndex([]);
    expect(index.total).toBe(0);
    expect(index.because).toContain('no research');
  });

  it('ignores docs of other types', () => {
    expect(researchIndex([doc('d1', 'decision'), doc('s1', 'spec')]).total).toBe(0);
  });

  it('groups by topic, alphabetically', () => {
    const index = researchIndex([
      doc('r1', 'research', { topic: 'retrieval' }),
      doc('r2', 'research', { topic: 'caching' }),
    ]);
    expect(index.byTopic.map((group) => group.topic)).toEqual(['caching', 'retrieval']);
  });

  it('sorts untopiced research last — it is a gap, not a category', () => {
    const index = researchIndex([
      doc('r1', 'research', {}),
      doc('r2', 'research', { topic: 'zzz-last-alphabetically' }),
    ]);
    expect(index.byTopic.map((g) => g.topic)).toEqual(['zzz-last-alphabetically', '(no topic)']);
  });

  it('orders entries within a topic newest first', () => {
    const index = researchIndex([
      doc('old', 'research', { topic: 't' }, { updatedAt: '2026-08-01T00:00:00.000Z' }),
      doc('new', 'research', { topic: 't' }, { updatedAt: '2026-08-29T00:00:00.000Z' }),
    ]);
    expect(index.byTopic[0]?.entries.map((e) => e.id)).toEqual(['new', 'old']);
  });

  it('names the research nothing asked for', () => {
    // The number that says whether the habit is working.
    const index = researchIndex([
      doc('linked', 'research', { topic: 't', related_work_items: ['TASK-001'] }),
      doc('orphan', 'research', { topic: 't' }),
    ]);
    expect(index.unlinked).toEqual(['orphan']);
  });

  it('names the research citing nothing', () => {
    const index = researchIndex([
      doc('cited', 'research', { topic: 't', sources: ['https://example.com'] }),
      doc('uncited', 'research', { topic: 't' }),
    ]);
    expect(index.uncited).toEqual(['uncited']);
  });

  it('falls back to the path rather than inventing a title', () => {
    // A missing title is a real state, and a generated one hides it.
    const index = researchIndex([doc('r1', 'research', { topic: 't' }, { title: null })]);
    expect(index.byTopic[0]?.entries[0]?.title).toBe('docs/r1.md');
  });

  it('survives metadata that is null or the wrong shape', () => {
    const index = researchIndex([
      doc('r1', 'research', null),
      doc('r2', 'research', { related_work_items: 'TASK-001', sources: 42 }),
    ]);
    expect(index.total).toBe(2);
    expect(index.byTopic[0]?.entries.every((e) => e.relatedWorkItems.length === 0)).toBe(true);
  });
});

describe('decisionLog', () => {
  const adr = (id: string, over: Record<string, unknown> = {}): DocRow =>
    doc(id, 'decision', { adr_id: id, status: 'accepted', ...over });

  it('is empty and says so', () => {
    expect(decisionLog([]).because).toContain('no decisions');
  });

  it('lists decisions by adr id', () => {
    const log = decisionLog([adr('ADR-0002'), adr('ADR-0001')]);
    expect(log.entries.map((e) => e.adrId)).toEqual(['ADR-0001', 'ADR-0002']);
  });

  it('walks a supersession chain forward', () => {
    const log = decisionLog([
      adr('ADR-0001', { status: 'superseded', superseded_by: 'ADR-0002' }),
      adr('ADR-0002', { supersedes: 'ADR-0001' }),
    ]);
    expect(log.chains).toEqual([['ADR-0001', 'ADR-0002']]);
    expect(log.issues).toEqual([]);
  });

  it('walks a three-link chain', () => {
    const log = decisionLog([
      adr('ADR-0001', { status: 'superseded', superseded_by: 'ADR-0002' }),
      adr('ADR-0002', { status: 'superseded', supersedes: 'ADR-0001', superseded_by: 'ADR-0003' }),
      adr('ADR-0003', { supersedes: 'ADR-0002' }),
    ]);
    expect(log.chains).toEqual([['ADR-0001', 'ADR-0002', 'ADR-0003']]);
  });

  it('gives an unrevisited decision a chain of one', () => {
    expect(decisionLog([adr('ADR-0001')]).chains).toEqual([['ADR-0001']]);
  });

  it('flags a pointer to an ADR that is not there', () => {
    const log = decisionLog([adr('ADR-0001', { status: 'superseded', superseded_by: 'ADR-0099' })]);
    expect(log.issues.map((i) => i.problem)).toContain('dangling-successor');
    expect(log.issues[0]?.because).toContain('dead end');
  });

  it('flags a claim to supersede an ADR that is not there', () => {
    const log = decisionLog([adr('ADR-0002', { supersedes: 'ADR-0099' })]);
    expect(log.issues.map((i) => i.problem)).toContain('dangling-predecessor');
  });

  it('flags superseded with nothing naming the replacement', () => {
    const log = decisionLog([adr('ADR-0001', { status: 'superseded' })]);
    expect(log.issues.map((i) => i.problem)).toContain('superseded-without-successor');
  });

  it('reports a cycle instead of walking it forever', () => {
    // `superseded_by` is hand-edited, so A → B → A is one typo away.
    const log = decisionLog([
      adr('ADR-0001', { status: 'superseded', superseded_by: 'ADR-0002', supersedes: 'ADR-0002' }),
      adr('ADR-0002', { status: 'superseded', superseded_by: 'ADR-0001', supersedes: 'ADR-0001' }),
    ]);
    expect(log.issues.map((i) => i.problem)).toContain('cycle');
  });

  it('walks forward from heads, so a chain with a dangling head is still found', () => {
    // Walking backward from the newest would miss it.
    const log = decisionLog([
      adr('ADR-0001', { status: 'superseded', superseded_by: 'ADR-0002' }),
      adr('ADR-0002', { supersedes: 'ADR-0001' }),
      adr('ADR-0003'),
    ]);
    expect(log.chains).toHaveLength(2);
    expect(log.chains).toContainEqual(['ADR-0003']);
  });

  it('reads a missing status as unknown rather than as accepted', () => {
    expect(decisionLog([doc('d1', 'decision', { adr_id: 'ADR-0001' })]).entries[0]?.status).toBe(
      'unknown',
    );
  });

  it('falls back to the doc id when there is no adr_id, and says it did', () => {
    // `doc_type` is assigned by directory, so an index README beside the ADRs
    // arrives here as a decision with no id. Keeping it is right; letting a file
    // path render as a real ADR id is not.
    const log = decisionLog([doc('docs/adr/README.md', 'decision', {})]);
    expect(log.entries[0]?.adrId).toBe('docs/adr/README.md');
    expect(log.entries[0]?.identified).toBe(false);
    expect(log.unidentified).toEqual(['docs/adr/README.md']);
    expect(log.because).toContain('without an adr_id');
  });

  it('marks a real ADR as identified', () => {
    expect(decisionLog([adr('ADR-0001')]).entries[0]?.identified).toBe(true);
    expect(decisionLog([adr('ADR-0001')]).unidentified).toEqual([]);
  });

  it('counts the chain problems in its summary', () => {
    const log = decisionLog([adr('ADR-0001', { status: 'superseded' })]);
    expect(log.because).toContain('1 chain problem');
  });
});
