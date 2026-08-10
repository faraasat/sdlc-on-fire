import { describe, expect, it } from 'vitest';
import { chunkCode, chunkFile, chunkMarkdown, indexableText } from './chunking.js';

describe('markdown chunking', () => {
  it('splits at headings and carries the path', () => {
    const chunks = chunkMarkdown('# Top\n\nintro\n\n## Sub\n\nbody\n');
    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.breadcrumb).toBe('Top');
    expect(chunks[1]?.breadcrumb).toBe('Top › Sub');
  });

  it('pops the stack when a heading level rises', () => {
    const chunks = chunkMarkdown('# A\n\nx\n\n## B\n\ny\n\n# C\n\nz\n');
    expect(chunks[2]?.breadcrumb).toBe('C');
  });

  it('does not treat a # inside a code fence as a heading', () => {
    // Splitting there would cut a code sample in half.
    const chunks = chunkMarkdown('# Top\n\n```sh\n# not a heading\necho hi\n```\n');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text).toContain('echo hi');
  });

  it('splits an over-long section on paragraphs, keeping the breadcrumb', () => {
    const long = `# Top\n\n${'a'.repeat(400)}\n\n${'b'.repeat(400)}\n`;
    const chunks = chunkMarkdown(long, 500);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.breadcrumb === 'Top')).toBe(true);
  });

  it('handles a document with no headings', () => {
    const chunks = chunkMarkdown('just prose\n');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.breadcrumb).toBe('');
  });

  it('numbers chunks in order', () => {
    const chunks = chunkMarkdown('# A\n\nx\n\n## B\n\ny\n');
    expect(chunks.map((c) => c.index)).toEqual([0, 1]);
  });
});

describe('code chunking', () => {
  it('splits at top-level exported symbols', () => {
    const source = 'import x from "y";\n\nexport function a() {}\n\nexport class B {}\n';
    const chunks = chunkCode(source, 'src/a.ts');
    expect(chunks.map((c) => c.breadcrumb)).toEqual(['src/a.ts', 'src/a.ts › a', 'src/a.ts › B']);
  });

  it('returns one chunk for a file with no recognised symbols', () => {
    // Never mis-splits: an unrecognised file comes back whole.
    const chunks = chunkCode('const x = 1;\n', 'src/x.ts');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.breadcrumb).toBe('src/x.ts');
  });

  it('ignores a non-exported declaration', () => {
    expect(chunkCode('function hidden() {}\n', 'src/a.ts')).toHaveLength(1);
  });
});

describe('routing and indexing', () => {
  it('routes by extension', () => {
    expect(chunkFile('# H\n\nx\n', 'docs/a.md')[0]?.breadcrumb).toBe('H');
    expect(chunkFile('export const a = 1;\n', 'src/a.ts')[0]?.breadcrumb).toContain('src/a.ts');
  });

  it('prefixes the breadcrumb for indexing', () => {
    // Lets a query match a section by heading even when the body never repeats it.
    const chunk = { text: 'body', breadcrumb: 'Top › Sub', index: 0 };
    expect(indexableText(chunk)).toBe('Top › Sub\n\nbody');
  });

  it('omits an empty breadcrumb', () => {
    expect(indexableText({ text: 'body', breadcrumb: '', index: 0 })).toBe('body');
  });
});
