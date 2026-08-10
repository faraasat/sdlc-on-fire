/**
 * Heading-aware Markdown chunking and basic code chunking (P1-CTX-02).
 *
 * v0.1 scope per mvp-slice: heading breadcrumbs for Markdown and top-level
 * symbol boundaries for code. Tree-sitter AST chunking is the later refinement —
 * the chunk *shape* here is what tsvector indexes, and it does not change when
 * the splitter gets smarter.
 *
 * Why breadcrumbs matter: a retrieved chunk arrives with no surroundings. "It
 * must be enabled before use" is useless without knowing what *it* is, so every
 * chunk carries the heading path it came from.
 */

export interface Chunk {
  readonly text: string;
  /** Parent-heading path for Markdown, scope path for code. */
  readonly breadcrumb: string;
  readonly index: number;
}

const DEFAULT_MAX_CHARS = 1_500;

interface HeadingLine {
  readonly level: number;
  readonly title: string;
}

function parseHeading(line: string): HeadingLine | null {
  const match = /^(#{1,6})\s+(.*)$/.exec(line);
  if (match === null) return null;
  return { level: match[1]?.length ?? 1, title: (match[2] ?? '').trim() };
}

function breadcrumbOf(stack: readonly HeadingLine[]): string {
  return stack.map((heading) => heading.title).join(' › ');
}

/**
 * Splits Markdown at heading boundaries, carrying the heading path.
 *
 * Fenced code blocks are passed through intact: a `#` inside a shell snippet is
 * a comment, not a heading, and splitting there would cut a code sample in half.
 */
export function chunkMarkdown(source: string, maxChars = DEFAULT_MAX_CHARS): Chunk[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const chunks: Chunk[] = [];
  const stack: HeadingLine[] = [];

  let buffer: string[] = [];
  let bufferBreadcrumb = '';
  let inFence = false;

  const flush = (): void => {
    const text = buffer.join('\n').trim();
    buffer = [];
    if (text.length === 0) return;

    // A section longer than the cap is split on paragraphs, keeping its
    // breadcrumb — a long section is still one topic.
    if (text.length <= maxChars) {
      chunks.push({ text, breadcrumb: bufferBreadcrumb, index: chunks.length });
      return;
    }
    let current = '';
    for (const paragraph of text.split(/\n{2,}/)) {
      if (current.length > 0 && current.length + paragraph.length + 2 > maxChars) {
        chunks.push({ text: current, breadcrumb: bufferBreadcrumb, index: chunks.length });
        current = '';
      }
      current = current.length === 0 ? paragraph : `${current}\n\n${paragraph}`;
    }
    if (current.trim().length > 0) {
      chunks.push({ text: current, breadcrumb: bufferBreadcrumb, index: chunks.length });
    }
  };

  for (const line of lines) {
    if (/^\s*```/.test(line)) inFence = !inFence;

    const heading = inFence ? null : parseHeading(line);
    if (heading !== null) {
      flush();
      while (stack.length > 0 && (stack[stack.length - 1]?.level ?? 0) >= heading.level) {
        stack.pop();
      }
      stack.push(heading);
      bufferBreadcrumb = breadcrumbOf(stack);
      buffer.push(line);
      continue;
    }

    if (buffer.length === 0 && bufferBreadcrumb === '') bufferBreadcrumb = breadcrumbOf(stack);
    buffer.push(line);
  }

  flush();
  return chunks;
}

const TOP_LEVEL_SYMBOL =
  /^export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|interface|type|enum)\s+([A-Za-z0-9_$]+)/;

/**
 * Splits source at top-level exported symbols.
 *
 * Deliberately syntactic, not semantic: it looks for exported declarations at
 * column zero. That misses nested and non-exported symbols, which is acceptable
 * because the retrieval target is "which file and roughly where", and it never
 * mis-splits — an unrecognised file comes back as one chunk rather than a
 * wrongly-cut one.
 */
export function chunkCode(source: string, filePath: string, maxChars = DEFAULT_MAX_CHARS): Chunk[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const chunks: Chunk[] = [];

  let buffer: string[] = [];
  let symbol = '';

  const flush = (): void => {
    const text = buffer.join('\n').trim();
    buffer = [];
    if (text.length === 0) return;
    chunks.push({
      text: text.slice(0, maxChars),
      breadcrumb: symbol === '' ? filePath : `${filePath} › ${symbol}`,
      index: chunks.length,
    });
  };

  for (const line of lines) {
    const match = TOP_LEVEL_SYMBOL.exec(line);
    if (match !== null) {
      flush();
      symbol = match[1] ?? '';
    }
    buffer.push(line);
  }

  flush();
  return chunks;
}

/** Routes to the right splitter by extension. */
export function chunkFile(source: string, filePath: string, maxChars = DEFAULT_MAX_CHARS): Chunk[] {
  return /\.(md|markdown)$/i.test(filePath)
    ? chunkMarkdown(source, maxChars)
    : chunkCode(source, filePath, maxChars);
}

/**
 * The indexable form: breadcrumb prefixed to the text.
 *
 * Indexing the breadcrumb alongside the body is what lets a query match a
 * section by its heading even when the body never repeats those words.
 */
export function indexableText(chunk: Chunk): string {
  return chunk.breadcrumb.length === 0 ? chunk.text : `${chunk.breadcrumb}\n\n${chunk.text}`;
}
