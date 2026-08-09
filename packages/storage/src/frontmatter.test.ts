import { describe, expect, it } from 'vitest';
import {
  FrontmatterError,
  isCanonical,
  orderKeys,
  parseFrontmatter,
  serializeFrontmatter,
} from './frontmatter.js';

describe('parsing', () => {
  it('splits frontmatter from body', () => {
    const parsed = parseFrontmatter('---\ntitle: Hello\n---\n\n# Body\n');
    expect(parsed.hasFrontmatter).toBe(true);
    expect(parsed.data).toEqual({ title: 'Hello' });
    expect(parsed.body).toBe('# Body\n');
  });

  it('treats a file with no fence as body-only', () => {
    const parsed = parseFrontmatter('# Just markdown\n');
    expect(parsed.hasFrontmatter).toBe(false);
    expect(parsed.data).toEqual({});
    expect(parsed.body).toBe('# Just markdown\n');
  });

  it('handles empty frontmatter', () => {
    expect(parseFrontmatter('---\n---\nbody\n').data).toEqual({});
  });

  it('strips a BOM rather than mistaking it for body', () => {
    expect(parseFrontmatter('﻿---\ntitle: x\n---\nbody\n').data).toEqual({ title: 'x' });
  });

  it('normalises CRLF', () => {
    expect(parseFrontmatter('---\r\ntitle: x\r\n---\r\nbody\r\n').data).toEqual({ title: 'x' });
  });

  it('refuses an unterminated fence instead of guessing', () => {
    // Treating the whole file as YAML would destroy it on the next write.
    expect(() => parseFrontmatter('---\ntitle: x\nno closing fence\n')).toThrow(FrontmatterError);
  });

  it('refuses frontmatter that is not a mapping', () => {
    expect(() => parseFrontmatter('---\n- a\n- b\n---\nbody\n')).toThrow(FrontmatterError);
  });

  it('reports invalid YAML as such', () => {
    expect(() => parseFrontmatter('---\na: [unclosed\n---\nbody\n')).toThrow(FrontmatterError);
  });

  it('does not treat a --- inside the body as a fence', () => {
    const parsed = parseFrontmatter('---\ntitle: x\n---\n\nintro\n\n---\n\nmore\n');
    expect(parsed.data).toEqual({ title: 'x' });
    expect(parsed.body).toContain('more');
  });
});

describe('key ordering', () => {
  it('puts canonical fields in contract order regardless of input order', () => {
    expect(orderKeys({ updated_at: 1, title: 2, id: 3, kind: 4 })).toEqual([
      'id',
      'kind',
      'title',
      'updated_at',
    ]);
  });

  it('sorts unknown keys alphabetically after the known ones', () => {
    expect(orderKeys({ zebra: 1, id: 2, apple: 3 })).toEqual(['id', 'apple', 'zebra']);
  });

  it('is total — an object of only unknown keys still orders stably', () => {
    expect(orderKeys({ b: 1, a: 2 })).toEqual(['a', 'b']);
  });
});

describe('deterministic serialization', () => {
  it('emits keys in canonical order', () => {
    const out = serializeFrontmatter({ updated_at: 'z', id: 'TASK-001', title: 'x' }, 'body');
    expect(out.indexOf('id:')).toBeLessThan(out.indexOf('title:'));
    expect(out.indexOf('title:')).toBeLessThan(out.indexOf('updated_at:'));
  });

  it('produces identical bytes for differently-ordered equivalent input', () => {
    // This is the property that keeps a one-field edit to a one-line diff.
    const a = serializeFrontmatter({ id: 'TASK-001', title: 'x' }, 'body');
    const b = serializeFrontmatter({ title: 'x', id: 'TASK-001' }, 'body');
    expect(a).toBe(b);
  });

  it('drops undefined rather than emitting null', () => {
    // An absent field must not come back as an explicit null next read, or every
    // round trip would grow the file.
    const out = serializeFrontmatter({ id: 'TASK-001', assignee: undefined }, 'body');
    expect(out).not.toContain('assignee');
  });

  it('keeps an explicit null', () => {
    expect(serializeFrontmatter({ id: 'TASK-001', parent_id: null }, 'body')).toContain(
      'parent_id: null',
    );
  });

  it('does not reflow long values', () => {
    const long = 'x'.repeat(300);
    expect(serializeFrontmatter({ title: long }, 'body')).toContain(long);
  });

  it('ends with exactly one trailing newline', () => {
    const out = serializeFrontmatter({ id: 'TASK-001' }, 'body\n\n\n');
    expect(out.endsWith('body\n')).toBe(true);
  });

  it('handles an empty body', () => {
    const out = serializeFrontmatter({ id: 'TASK-001' }, '');
    expect(out).toBe('---\nid: TASK-001\n---\n');
  });
});

describe('round trip', () => {
  const cases: Record<string, unknown>[] = [
    { id: 'TASK-001', title: 'Simple' },
    { id: 'TASK-002', labels: ['a', 'b'], wave: 3 },
    {
      id: 'TASK-003',
      external_ref: { source_tool: 'jira', source_path: 'x', source_id_or_hash: '1' },
    },
    { id: 'TASK-004', title: 'Colons: and #hashes', done: ['a: b'] },
    { id: 'TASK-005', parent_id: null, verify: 'pnpm test -- --run' },
  ];

  it.each(cases)('parse(serialize(x)) === x for %j', (data) => {
    const serialized = serializeFrontmatter(data, 'the body\n');
    const parsed = parseFrontmatter(serialized);
    expect(parsed.data).toEqual(data);
    expect(parsed.body).toBe('the body\n');
  });

  it('is idempotent — serializing twice changes nothing', () => {
    const once = serializeFrontmatter({ title: 'x', id: 'TASK-001' }, 'body');
    const twice = serializeFrontmatter(parseFrontmatter(once).data, parseFrontmatter(once).body);
    expect(twice).toBe(once);
  });

  it('recognises an already-canonical document', () => {
    const canonical = serializeFrontmatter({ id: 'TASK-001', title: 'x' }, 'body');
    expect(isCanonical(canonical)).toBe(true);
  });

  it('recognises a non-canonical document', () => {
    // Keys out of contract order — rewriting this file is a real improvement.
    expect(isCanonical('---\ntitle: x\nid: TASK-001\n---\n\nbody\n')).toBe(false);
  });
});
