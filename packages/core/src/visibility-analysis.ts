/**
 * Analysing a recorded corpus (P5-VIZ-02, ADR-0074).
 *
 * Everything downstream of the raw responses lives here, and every function is
 * pure: given the same corpus it returns the same numbers, forever, with no
 * network and no clock. The stochastic half is quarantined at the boundary in
 * [`visibility-matrix.ts`](visibility-matrix.ts), and the corpus it produces is
 * the evidence artifact — so an analysis can be re-run, disagreed with, and
 * checked years later against the same bytes (ADR-0040).
 *
 * Three rules from ADR-0074 are enforced here rather than remembered:
 *
 *   * **Per-level, never aggregated.** Mention and citation are counted
 *     separately with separate denominators and never summed. A composite would
 *     hide an upstream loss behind a downstream gain, which is precisely what
 *     SAGEO Arena measured.
 *   * **Intervals are mandatory.** A point estimate from this instrument is a
 *     lie by omission, so `Rate` has no constructor that omits one — the type
 *     makes the unqualified number unrepresentable rather than discouraged.
 *   * **Sentiment is out of scope**, at any budget we would fund. Across
 *     102,025 responses sentiment flipped 45.5% of the time against 6.8% for
 *     mention — 6.7× noisier — so reporting it from the same sample that
 *     supports a mention rate is reporting a coin flip with a decimal point on
 *     it. There is deliberately no sentiment function in this file.
 */

import type { RecordedResponse, ResponseCorpus, VisibilityEngine } from './visibility-matrix.js';

/**
 * A measured proportion, which cannot exist without its uncertainty.
 *
 * There is no way to build one of these carrying only `value`. That is the
 * point: every path that produces a number here produces its interval at the
 * same moment, so a caller cannot reach for the convenient half.
 */
export interface Rate {
  readonly hits: number;
  readonly attempts: number;
  readonly value: number;
  /** Wilson score interval, 95%. Lower and upper bounds on the true proportion. */
  readonly low: number;
  readonly high: number;
}

/**
 * Wilson score interval rather than the normal approximation.
 *
 * The normal interval is the one everybody writes and it is wrong exactly where
 * this instrument operates: small samples and proportions near 0 or 1. At 0/12
 * it produces the interval [0, 0] — a confident claim of impossibility from
 * twelve observations — while Wilson gives [0, 0.24], which is the honest
 * reading. A harness whose whole purpose is refusing overconfident numbers
 * cannot ship the overconfident interval.
 */
export function wilson(hits: number, attempts: number, z = 1.96): Rate {
  if (attempts <= 0) {
    return { hits: 0, attempts: 0, value: 0, low: 0, high: 1 };
  }
  const p = hits / attempts;
  const z2 = z * z;
  const denominator = 1 + z2 / attempts;
  const centre = p + z2 / (2 * attempts);
  const spread = z * Math.sqrt((p * (1 - p)) / attempts + z2 / (4 * attempts * attempts));
  return {
    hits,
    attempts,
    value: p,
    low: Math.max(0, (centre - spread) / denominator),
    high: Math.min(1, (centre + spread) / denominator),
  };
}

/** How a subject is looked for in an answer. Case-insensitive, whole-word. */
export function mentions(text: string, subject: string): boolean {
  const escaped = subject.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (escaped === '') return false;
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`, 'i').test(text);
}

/** Whether any citation points at a host. Compared on host, not on the whole URL. */
export function citesHost(citations: readonly string[], host: string): boolean {
  const target = host
    .trim()
    .toLowerCase()
    .replace(/^www\./, '');
  if (target === '') return false;
  return citations.some((url) => {
    try {
      return new URL(url).host.toLowerCase().replace(/^www\./, '') === target;
    } catch {
      // A citation that is not a URL is not a match. Substring-matching the raw
      // string instead would count `notexample.com` as `example.com`.
      return false;
    }
  });
}

export interface LevelCounts {
  /** Answers where the subject was named. */
  readonly mention: Rate;
  /** Answers citing the subject's own domain. */
  readonly citation: Rate;
  /** Cells that produced an answer at all — the denominator everything else rests on. */
  readonly answered: Rate;
}

export interface VisibilityAnalysis {
  readonly subject: string;
  readonly host: string;
  readonly overall: LevelCounts;
  /** Per engine, because model identity is a condition and not a summary. */
  readonly byEngine: readonly { readonly engine: VisibilityEngine; readonly counts: LevelCounts }[];
  /** Failed cells, carried so a reader can see how much of the run worked. */
  readonly failures: number;
}

function countLevels(
  responses: readonly RecordedResponse[],
  subject: string,
  host: string,
): LevelCounts {
  const attempts = responses.length;
  const usable = responses.filter((response) => response.error === undefined);

  // Mention and citation are measured against *usable* answers, and `answered`
  // reports how many those were. Dividing them by total attempts instead would
  // fold "the API was down" into "nobody mentions you" — two different facts
  // with the same shape.
  return {
    answered: wilson(usable.length, attempts),
    mention: wilson(
      usable.filter((response) => mentions(response.text, subject)).length,
      usable.length,
    ),
    citation: wilson(
      usable.filter((response) => citesHost(response.citations, host)).length,
      usable.length,
    ),
  };
}

/**
 * Analyse a corpus.
 *
 * Nothing here is summed across levels and nothing is scored. The output is a
 * table a person reads, with every number carrying the count it came from.
 */
export function analyseVisibility(
  corpus: ResponseCorpus,
  subject: string,
  host: string,
): VisibilityAnalysis {
  const engines = [...new Set(corpus.responses.map((response) => response.cell.engine))].sort();

  return {
    subject,
    host,
    overall: countLevels(corpus.responses, subject, host),
    byEngine: engines.map((engine) => ({
      engine,
      counts: countLevels(
        corpus.responses.filter((response) => response.cell.engine === engine),
        subject,
        host,
      ),
    })),
    failures: corpus.responses.filter((response) => response.error !== undefined).length,
  };
}

/**
 * Which third-party sources were cited, and how often (P5-VIZ-03).
 *
 * Factual and per-response — no statistics, no interval, because this is a
 * count of things that happened rather than an estimate of a proportion. It is
 * the most useful thing the corpus holds: across 102,025 responses only **2.9%**
 * of citations pointed at the brand's own domain and **75.2%** at other
 * companies, so where a project's reputation actually lives is somebody else's
 * page — and this says whose.
 */
export function citedSources(
  corpus: ResponseCorpus,
): readonly { readonly host: string; readonly count: number }[] {
  const counts = new Map<string, number>();
  for (const response of corpus.responses) {
    // Per response, not per citation: a page cited three times in one answer is
    // one answer citing it, and counting the repeats would let a single verbose
    // response outweigh ten others.
    const hosts = new Set<string>();
    for (const url of response.citations) {
      try {
        hosts.add(new URL(url).host.toLowerCase().replace(/^www\./, ''));
      } catch {
        continue;
      }
    }
    for (const host of hosts) counts.set(host, (counts.get(host) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([host, count]) => ({ host, count }))
    .sort((a, b) => b.count - a.count || a.host.localeCompare(b.host));
}
