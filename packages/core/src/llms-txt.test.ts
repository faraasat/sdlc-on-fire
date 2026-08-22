import { describe, expect, it } from 'vitest';
import { LLMS_TXT_PATH, compileLlmsTxt, titleFor, type LlmsTxtDoc } from './llms-txt.js';

/**
 * P4-DOC-02 — the `llms.txt` compile target.
 *
 * This is a generated file that gets committed, so determinism is the property
 * under test throughout: a generator whose output depends on directory order
 * produces a diff every time anyone runs it, and a diff that appears without a
 * change is how people learn to stop reading diffs.
 */

const doc = (over: Partial<LlmsTxtDoc> = {}): LlmsTxtDoc => ({
  path: 'docs/guide.md',
  title: 'Guide',
  ...over,
});

describe('compileLlmsTxt', () => {
  it('opens with the project name as an H1', () => {
    expect(compileLlmsTxt({ project: 'sdlc-on-fire', docs: [] })).toBe('# sdlc-on-fire\n');
  });

  it('renders a summary as a blockquote', () => {
    const out = compileLlmsTxt({ project: 'p', summary: 'A thing.', docs: [] });
    expect(out).toContain('> A thing.');
  });

  it('omits the blockquote when there is no summary', () => {
    expect(compileLlmsTxt({ project: 'p', summary: '  ', docs: [] })).not.toContain('>');
  });

  it('groups docs under sections', () => {
    const out = compileLlmsTxt({
      project: 'p',
      docs: [doc({ section: 'Reference', title: 'API' }), doc({ section: 'Docs', title: 'Start' })],
    });
    expect(out.indexOf('## Docs')).toBeLessThan(out.indexOf('## Reference'));
  });

  it('defaults an unsectioned doc to Documentation', () => {
    expect(compileLlmsTxt({ project: 'p', docs: [doc()] })).toContain('## Documentation');
  });

  it('sorts docs by title within a section, not by input order', () => {
    // The determinism that matters: input order is directory order.
    const out = compileLlmsTxt({
      project: 'p',
      docs: [doc({ title: 'Zebra', path: 'z.md' }), doc({ title: 'Apple', path: 'a.md' })],
    });
    expect(out.indexOf('Apple')).toBeLessThan(out.indexOf('Zebra'));
  });

  it('produces byte-identical output for reordered input', () => {
    const docs = [
      doc({ title: 'B', path: 'b.md', section: 'Docs' }),
      doc({ title: 'A', path: 'a.md', section: 'Reference' }),
      doc({ title: 'C', path: 'c.md', section: 'Docs' }),
    ];
    const forward = compileLlmsTxt({ project: 'p', docs });
    const reversed = compileLlmsTxt({ project: 'p', docs: [...docs].reverse() });
    expect(forward).toBe(reversed);
  });

  it('breaks a title tie by path so the order is total', () => {
    const out = compileLlmsTxt({
      project: 'p',
      docs: [doc({ title: 'Same', path: 'z.md' }), doc({ title: 'Same', path: 'a.md' })],
    });
    expect(out.indexOf('a.md')).toBeLessThan(out.indexOf('z.md'));
  });

  it('appends a doc summary after the link', () => {
    const out = compileLlmsTxt({ project: 'p', docs: [doc({ summary: 'how to start' })] });
    expect(out).toContain('- [Guide](docs/guide.md): how to start');
  });

  it('links relatively when no base URL is set', () => {
    // An invented origin resolves to a 404; a relative link at least composes
    // with wherever the file is actually served.
    expect(compileLlmsTxt({ project: 'p', docs: [doc()] })).toContain('(docs/guide.md)');
  });

  it('prefixes a base URL without doubling the slash', () => {
    const out = compileLlmsTxt({
      project: 'p',
      baseUrl: 'https://example.com/',
      docs: [doc({ path: '/docs/guide.md' })],
    });
    expect(out).toContain('(https://example.com/docs/guide.md)');
  });

  it('ends with exactly one trailing newline', () => {
    // A generator that omits one produces a diff against every editor that adds
    // it back.
    const out = compileLlmsTxt({ project: 'p', docs: [doc()] });
    expect(out.endsWith('\n')).toBe(true);
    expect(out.endsWith('\n\n')).toBe(false);
  });

  it('handles an empty corpus without emitting an empty section', () => {
    expect(compileLlmsTxt({ project: 'p', docs: [] })).not.toContain('##');
  });
});

describe('titleFor', () => {
  it('prefers the declared title', () => {
    expect(titleFor({ path: 'docs/x.md', title: 'How retries work' })).toBe('How retries work');
  });

  it('falls back to the filename without its extension', () => {
    expect(titleFor({ path: 'docs/deep/retry-policy.md' })).toBe('retry-policy');
  });

  it('treats a blank title as absent rather than rendering nothing', () => {
    expect(titleFor({ path: 'docs/x.md', title: '   ' })).toBe('x');
  });
});

describe('LLMS_TXT_PATH', () => {
  it('is the well-known path, which is the whole point of the convention', () => {
    expect(LLMS_TXT_PATH).toBe('llms.txt');
  });
});
