/**
 * Plain-language user guides and their diagrams (P1-DOC-03, ADR-0057).
 *
 * Two audiences, two registers. An agent-facing doc can be terse and dense and
 * assume the reader knows what a lifecycle stage is. A user guide cannot, and
 * the usual failure is not that someone writes a *bad* guide — it is that the
 * same person who just wrote the implementation writes the guide, in the
 * vocabulary they have been using all day, and it reads fine to them.
 *
 * So the readability check is deterministic and mechanical: sentence length,
 * syllable count, and a jargon list drawn from the product's own vocabulary. It
 * cannot tell whether a guide is *helpful* — nothing can — but it can tell that
 * a sentence is forty words long and contains the word "idempotency", and that
 * is most of what goes wrong.
 *
 * The diagram rules come from WCAG rather than taste. Colour is never the only
 * signal (1.4.1), `accTitle`/`accDescr` are mandatory on user-facing diagrams,
 * and `%%{init}%%` is refused because mermaid deprecated it in v10.5 — a guide
 * whose diagram silently stops rendering is worse than one with no diagram.
 */

export interface ReadabilityFinding {
  readonly kind: 'long-sentence' | 'jargon' | 'passive-heavy';
  readonly detail: string;
  readonly excerpt: string;
}

/** Words that mean something precise to us and nothing to a stakeholder. */
export const PRODUCT_JARGON: readonly string[] = [
  'idempotency',
  'idempotent',
  'lifecycle stage',
  'evidence envelope',
  'context pack',
  'role_effect',
  'disposer',
  'subagent',
  'tsvector',
  'preset',
  'gate policy',
  'work item',
];

/** Above this, a sentence is doing too much for a reader who is new to this. */
export const MAX_SENTENCE_WORDS = 25;

export interface ReadabilityReport {
  readonly findings: readonly ReadabilityFinding[];
  readonly sentences: number;
  /** Flesch reading ease. ~60+ is plain English; reported, never gated on. */
  readonly readingEase: number;
  /** Fails only on jargon — the one finding that is a fact about a word list. */
  readonly ok: boolean;
}

/**
 * Checks a guide's prose.
 *
 * Jargon gates because it is decidable: the word is in the list or it is not.
 * Sentence length and reading ease advise, because a long sentence is sometimes
 * the right sentence, and a score that failed builds would be met by splitting
 * clauses until the number moved rather than by writing more clearly.
 */
export function checkReadability(text: string): ReadabilityReport {
  const findings: ReadabilityFinding[] = [];
  // Code blocks are stripped once, and everything below reads the stripped
  // text. A command called `--context pack` is not the guide using jargon; it
  // is the guide quoting the thing the reader has to type.
  const prose = text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]+`/g, ' ');
  const sentences = prose
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.replace(/\s+/g, ' ').trim())
    .filter((sentence) => sentence.length > 0 && !sentence.startsWith('#'));

  let words = 0;
  let syllables = 0;

  for (const sentence of sentences) {
    const parts = sentence.split(/\s+/).filter(Boolean);
    words += parts.length;
    for (const word of parts) syllables += syllablesIn(word);

    if (parts.length > MAX_SENTENCE_WORDS) {
      findings.push({
        kind: 'long-sentence',
        detail: `${String(parts.length)} words`,
        excerpt: `${sentence.slice(0, 70)}…`,
      });
    }
  }

  const lower = prose.toLowerCase();
  for (const term of PRODUCT_JARGON) {
    if (new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(lower)) {
      findings.push({
        kind: 'jargon',
        detail: `"${term}" means something precise to us and nothing to a stakeholder`,
        excerpt: term,
      });
    }
  }

  const readingEase =
    sentences.length === 0 || words === 0
      ? 0
      : Math.round(
          (206.835 - 1.015 * (words / sentences.length) - 84.6 * (syllables / words)) * 10,
        ) / 10;

  return {
    findings,
    sentences: sentences.length,
    readingEase,
    ok: !findings.some((finding) => finding.kind === 'jargon'),
  };
}

/** Rough syllable count. Crude, and named so nobody mistakes it for linguistics. */
function syllablesIn(word: string): number {
  const clean = word.toLowerCase().replace(/[^a-z]/g, '');
  if (clean.length === 0) return 0;
  const groups = clean.replace(/e$/, '').match(/[aeiouy]+/g);
  return Math.max(1, groups?.length ?? 1);
}

/* ------------------------------------------------------------------- diagrams */

export type DiagramAudience = 'user' | 'agent';

export interface DiagramFinding {
  readonly rule: string;
  readonly detail: string;
}

/**
 * A vetted palette, contrast-checked against white and near-black text.
 *
 * Not all built-in mermaid themes pass WCAG AA (.research/28), so the palette is
 * ours rather than a theme name — a theme that changes between mermaid releases
 * would change every guide's contrast without anyone editing a diagram.
 */
export const WCAG_PALETTE: readonly {
  readonly name: string;
  readonly fill: string;
  readonly stroke: string;
}[] = [
  { name: 'step', fill: '#1B4965', stroke: '#0B2A3D' },
  { name: 'decision', fill: '#5FA8D3', stroke: '#1B4965' },
  { name: 'done', fill: '#2E6F40', stroke: '#17331F' },
  { name: 'blocked', fill: '#8A2B2B', stroke: '#4A1414' },
];

/**
 * Checks a mermaid block against the rules a user-facing diagram has to meet.
 *
 * Agent-facing diagrams are exempt from colour and accessibility hooks — the
 * audience is a model or a developer reading a dense doc, and requiring an
 * `accDescr` on every internal sequence diagram would produce a hundred
 * perfunctory ones, which helps nobody.
 */
export function checkDiagram(source: string, audience: DiagramAudience): readonly DiagramFinding[] {
  const findings: DiagramFinding[] = [];

  if (/%%\{\s*init\s*:/.test(source)) {
    findings.push({
      rule: 'no-init-directive',
      // Deprecated since mermaid v10.5. A guide whose diagram silently stops
      // rendering is worse than one with no diagram.
      detail: '`%%{init}%%` is deprecated — put the config in YAML frontmatter instead',
    });
  }

  if (audience === 'agent') return findings;

  if (!/accTitle\s*:/.test(source)) {
    findings.push({ rule: 'acc-title', detail: 'user-facing diagrams need an `accTitle`' });
  }
  if (!/accDescr\s*[:{]/.test(source)) {
    findings.push({ rule: 'acc-descr', detail: 'user-facing diagrams need an `accDescr`' });
  }
  if (!/classDef\s/.test(source)) {
    findings.push({
      rule: 'colour',
      detail: 'user-facing diagrams are coloured, via `classDef` from the vetted palette',
    });
  }

  // WCAG 1.4.1: colour is never the only signal. A reader who cannot
  // distinguish the fills must still be able to read the diagram, so a coloured
  // class has to change something else too.
  const classDefs = [...source.matchAll(/classDef\s+(\S+)\s+([^\n]*)/g)];
  for (const [, name, body] of classDefs) {
    const styled = body ?? '';
    const carriesFill = /fill:/.test(styled);
    const carriesOther = /stroke-dasharray:|stroke-width:/.test(styled);
    if (carriesFill && !carriesOther) {
      findings.push({
        rule: 'colour-not-alone',
        detail: `classDef "${name ?? '?'}" distinguishes by fill only — pair it with a stroke or dash pattern (WCAG 1.4.1)`,
      });
    }
  }

  return findings;
}
