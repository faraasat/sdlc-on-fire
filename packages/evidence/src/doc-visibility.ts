/**
 * The doc-visibility dimension (P4-DOC-01, ADR-0074).
 *
 * A third checker beside `doc-freshness` (is this doc current?) and
 * `doc-health` (is the corpus coherent?): can an answer engine — or an agent
 * reading on somebody's behalf — find this page and use it correctly?
 *
 * **Every check here is offline, deterministic and unaggregated**, and each of
 * those three words is a decision recorded in [ADR-0074](../../../docs/.plan/decisions/ADR-0074-geo-visibility-scope-and-boundaries.md).
 *
 *   * *Offline*: no engine is queried. What a search engine did once is not a
 *     property of the document, and a checker that phoned one would report a
 *     different answer to the same file on two consecutive runs.
 *   * *Deterministic*: every finding below is countable by reading the text.
 *     There is no model in this path (ADR-0040).
 *   * *Unaggregated*: findings are listed, never summed. `techniques/41` §2's
 *     SAGEO result is the reason — body-only optimisation *reduced* top-20
 *     presence ~9% while improving other measures, so a single number would
 *     have shown an improvement where there was a regression.
 *
 * **What is checked is what the evidence says drives citation, and nothing
 * else.** The 252,000-trial factorial study behind `techniques/41` §3 found
 * topic match, concrete specifics, a recent-and-true timestamp and keyword
 * coverage to be gatekeepers or strong differentiators — and found **formatting
 * and visual structure to have no effect at all**. So formatting is deliberately
 * not checked here, and that absence is the finding rather than an omission: a
 * checker that scored heading structure would be measuring something the
 * experiment looked for and did not find.
 */

/** One thing about a document that the evidence associates with being cited. */
export const VISIBILITY_CHECKS = [
  'title-question',
  'stale-timestamp',
  'hedged-prose',
  'no-specifics',
  'keyword-gap',
  // Prose tells (P4-DOC-03). Deliberately in this module rather than beside it:
  // `techniques/44` §5 found the citation-visibility properties and the
  // reads-as-machine-written properties are largely one set, and building them
  // separately would produce two checkers disagreeing about hedged prose.
  'tagline-under-heading',
  'tricolon-density',
  'not-just-construction',
  'em-dash-rate',
  'no-authorial-choice',
] as const;
export type VisibilityCheck = (typeof VISIBILITY_CHECKS)[number];

export interface VisibilityFinding {
  readonly check: VisibilityCheck;
  readonly path: string;
  /** What was found, in the document's own terms. */
  readonly detail: string;
  /**
   * Whether the evidence calls this a gatekeeper (unanimous across six models,
   * odds ratios far above the differentiators) or a weaker signal.
   */
  /**
   * `style` is reported and never blocks. `techniques/44` §4 is explicit that a
   * document with no concrete anchor is *the* failure and the rest is style —
   * and a project is entitled to a style. A check that refused on tricolon
   * density would be a linter nobody keeps switched on, which is worse than no
   * check because it takes the anchor finding down with it.
   */
  readonly weight: 'gatekeeper' | 'differentiator' | 'style';
}

export interface VisibilityDoc {
  readonly path: string;
  readonly title: string | null;
  readonly body: string;
  /** ISO date the doc claims to have been updated, when it states one. */
  readonly updated?: string | undefined;
  /** Terms this doc should cover to match the question it answers. */
  readonly keywords?: readonly string[] | undefined;
}

export interface VisibilityReport {
  readonly findings: readonly VisibilityFinding[];
  readonly docsScanned: number;
}

/**
 * Hedges, counted rather than judged.
 *
 * Hedged language was a strong differentiator against citation (odds ratios
 * from 2.67 to 754 across models). This is a word list, which is a blunt
 * instrument and deliberately one: the alternative is a model deciding what
 * reads as hedged, and that is the thing ADR-0040 exists to refuse. A blunt
 * count a writer can argue with beats a confident score they cannot.
 */
const HEDGES = [
  'might',
  'may possibly',
  'could potentially',
  'generally speaking',
  'in some cases',
  'it depends',
  'arguably',
  'somewhat',
  'fairly',
  'relatively',
  'often',
  'typically',
  'usually',
  'tends to',
  'more or less',
];

/** Any digit, a version, a measurement, or a proper path — the shapes a specific claim takes. */
const SPECIFIC =
  /\b\d+(?:\.\d+)*\b|\b[a-zA-Z0-9_-]+\.(?:ts|js|md|json|ya?ml)\b|\b\d+\s*(?:ms|s|kb|mb|gb|%)\b/i;

const STALE_AFTER_DAYS = 365;

/** A heading and nothing else. Deliberately strict: any prose at all is content. */
function isStub(doc: VisibilityDoc): boolean {
  const withoutHeadings = doc.body.replace(/^#{1,6}\s+.*$/gm, '').trim();
  return withoutHeadings === '';
}

/**
 * Check one document.
 *
 * `now` is a parameter rather than a call, because a check whose result depends
 * on the wall clock is a check that cannot be tested at its own boundary.
 */
export function checkVisibility(doc: VisibilityDoc, now: Date): readonly VisibilityFinding[] {
  const findings: VisibilityFinding[] = [];
  const body = doc.body;

  // A stub — a heading with nothing under it — is skipped entirely, and this is
  // a category boundary rather than a convenience. An unwritten document is not
  // a document that is hard to find; "this file is empty" is doc-health's
  // finding, and reporting it here as four visibility failures says the fix is
  // to retitle and date a page that has no content to be found.
  //
  // Found by running the checker on a freshly scaffolded workspace: `init`
  // writes eleven one-line stubs, and the first run produced 42 gatekeeper
  // findings before the user had written a word. A check that is 100% noise on
  // a new project is a check people learn to skip.
  if (isStub(doc)) return [];

  // Topic match was the strongest gatekeeper in the study. Offline, the closest
  // honest proxy is whether the document names the question it answers — a
  // title that is a bare noun ("Configuration") matches no question anyone
  // types, where "How configuration is resolved" does.
  // A title that *is* an identifier — a package name, a command, a file — is a
  // topic match by construction: somebody searching for `@scope/pkg` matches it
  // exactly. Requiring three words there would flag every package README in
  // existence, which is how a check earns a reputation for being wrong. Found
  // by running this over our own nine READMEs and getting nine findings that
  // were all false.
  const titled = doc.title?.trim() ?? '';
  const isIdentifier = titled !== '' && !/\s/.test(titled) && /[@/._-]/.test(titled);
  if (!isIdentifier && (doc.title === null || titled.split(/\s+/).length < 3)) {
    findings.push({
      check: 'title-question',
      path: doc.path,
      detail:
        doc.title === null
          ? 'no title'
          : `title "${doc.title}" is too short to match a question anyone asks`,
      weight: 'gatekeeper',
    });
  }

  // A recent *and true* timestamp. Absent is reported as well as old: an
  // undated page cannot be judged current by anything reading it.
  if (doc.updated === undefined) {
    findings.push({
      check: 'stale-timestamp',
      path: doc.path,
      detail: 'no updated date, so nothing reading this can tell whether it is current',
      weight: 'gatekeeper',
    });
  } else {
    const when = Date.parse(doc.updated);
    if (Number.isNaN(when)) {
      findings.push({
        check: 'stale-timestamp',
        path: doc.path,
        detail: `updated date "${doc.updated}" is not a date`,
        weight: 'gatekeeper',
      });
    } else {
      const days = Math.floor((now.getTime() - when) / 86_400_000);
      if (days > STALE_AFTER_DAYS) {
        findings.push({
          check: 'stale-timestamp',
          path: doc.path,
          detail: `last updated ${String(days)} days ago`,
          weight: 'gatekeeper',
        });
      }
    }
  }

  const lower = body.toLowerCase();
  const hedges = HEDGES.filter((hedge) => lower.includes(hedge));
  if (hedges.length >= 3) {
    findings.push({
      check: 'hedged-prose',
      path: doc.path,
      detail: `hedges: ${hedges.slice(0, 5).join(', ')}`,
      weight: 'differentiator',
    });
  }

  if (body.trim() !== '' && !SPECIFIC.test(body)) {
    findings.push({
      check: 'no-specifics',
      path: doc.path,
      detail: 'no numbers, versions, measurements or filenames anywhere in the body',
      weight: 'differentiator',
    });
  }

  findings.push(...styleTells(doc));

  const missing = (doc.keywords ?? []).filter((word) => !lower.includes(word.toLowerCase()));
  if (missing.length > 0) {
    findings.push({
      check: 'keyword-gap',
      path: doc.path,
      detail: `declared but never mentioned: ${missing.join(', ')}`,
      weight: 'differentiator',
    });
  }

  return findings;
}

/**
 * The stylistic tells (P4-DOC-03).
 *
 * Every one is a *signal*, not a verdict, and none of them gates. They exist
 * because a reader can act on "this reads as generated and here is the line",
 * where a detector score tells them nothing they can change — and detectors do
 * not work anyway: `techniques/44` §2 records them flagging human writing
 * 9–15% of the time and missing humanised text 96% of the time, so optimising
 * against one optimises against noise. No detector is called here and none ever
 * should be.
 */
function styleTells(doc: VisibilityDoc): readonly VisibilityFinding[] {
  const findings: VisibilityFinding[] = [];
  const body = doc.body;

  // A bold one-line tagline immediately under the H1. Near-universal in
  // generated READMEs and almost nobody writes it by hand.
  if (/^#\s+.+\n+\*\*[^*\n]{10,}\*\*\s*$/m.test(body)) {
    findings.push({
      check: 'tagline-under-heading',
      path: doc.path,
      detail: 'a bold one-line tagline sits directly under the heading',
      weight: 'style',
    });
  }

  // "not just X, but Y" / "it is not A — it is B". The signature construction.
  const notJust = body.match(
    /\bnot (?:just|only|merely)\b[^.!?\n]{0,80}?\b(?:but|it'?s|it is)\b/gi,
  );
  if (notJust !== null && notJust.length > 0) {
    findings.push({
      check: 'not-just-construction',
      path: doc.path,
      detail: `"${notJust[0]?.slice(0, 60) ?? ''}"`,
      weight: 'style',
    });
  }

  // Tricolons: "fast, safe, and analyzable". Rhetorically satisfying, and
  // models reach for it constantly.
  const tricolons = body.match(/\b\w+, \w+,? and \w+\b/g) ?? [];
  const words = body.split(/\s+/).filter(Boolean).length;
  if (words > 0 && tricolons.length >= 3 && tricolons.length / words > 0.004) {
    findings.push({
      check: 'tricolon-density',
      path: doc.path,
      detail: `${String(tricolons.length)} three-part lists in ${String(words)} words`,
      weight: 'style',
    });
  }

  // Em-dash rate far above a corpus norm. A known fingerprint — and one this
  // very file would trip, which is exactly why it does not gate anything.
  const emDashes = (body.match(/—/g) ?? []).length;
  if (words > 100 && emDashes / words > 0.01) {
    findings.push({
      check: 'em-dash-rate',
      path: doc.path,
      detail: `${String(emDashes)} em dashes in ${String(words)} words`,
      weight: 'style',
    });
  }

  // Models describe; authors decide. A doc that never records a choice is a
  // doc nobody made a decision in.
  if (words > 150 && !/\b(?:we|I) (?:chose|picked|decided|rejected|prefer|avoided)\b/i.test(body)) {
    findings.push({
      check: 'no-authorial-choice',
      path: doc.path,
      detail: 'no recorded decision ("we chose X over Y because …")',
      weight: 'style',
    });
  }

  return findings;
}

/** Check a corpus. Findings are listed per document and never summed (ADR-0074). */
export function checkCorpusVisibility(docs: readonly VisibilityDoc[], now: Date): VisibilityReport {
  return {
    findings: docs.flatMap((doc) => checkVisibility(doc, now)),
    docsScanned: docs.length,
  };
}

/**
 * Split a markdown document into the fields this checker needs.
 *
 * The title is the first `# ` heading rather than the filename: the filename is
 * an identity, and what a reader or a retriever sees is the heading.
 */
export function readVisibilityDoc(
  path: string,
  raw: string,
  frontmatter: Record<string, unknown> = {},
): VisibilityDoc {
  const titleMatch = /^#\s+(.+)$/m.exec(raw);
  const updated = frontmatter['updated'] ?? frontmatter['last_updated'];
  const keywords = frontmatter['keywords'];
  return {
    path,
    title: titleMatch?.[1]?.trim() ?? null,
    body: raw,
    ...(typeof updated === 'string' ? { updated } : {}),
    ...(Array.isArray(keywords)
      ? { keywords: keywords.filter((k): k is string => typeof k === 'string') }
      : {}),
  };
}
