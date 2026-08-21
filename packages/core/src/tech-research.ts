import { assessSources } from './source-tier.js';
/**
 * The tech-research engine's vocabulary and its checker (P2-RES-01, ADR-0045).
 *
 * ADR-0045's rule is that no technology gets worked from training data: before
 * code is written against Next.js or Supabase or a payment SDK, that technology
 * gets a dated, cited, refreshable research folder, and **after `refresh-by`
 * the doc is treated as no research at all**.
 *
 * The interesting design question is what a *program* can contribute to that,
 * given the research itself is a web-enabled reading task no deterministic
 * function can perform. The answer this module commits to:
 *
 *   **It cannot do the research. It makes un-research impossible to mistake
 *   for research.**
 *
 * That is ADR-0040's split with a library manual in front of it. The agent
 * proposes — it reads the official docs and fills the folder in. The checker
 * disposes, and every one of its questions is mechanical: is the folder there,
 * are all four files there, is each one dated, does it name sources, is the
 * date in the future, and is the text still the template's? None of those
 * require judgement, and all of them are the ways a research folder ends up
 * looking complete while containing nothing.
 *
 * **The failure mode being engineered against is not a missing folder.** A
 * missing folder is loud. The quiet one is a folder that exists, is committed,
 * is linked from a task, and consists of the template's own prompts — or one
 * that was genuinely researched fourteen months ago against a major version
 * that no longer exists. Both read as "researched" to anything that only checks
 * for the directory.
 */

/** The four files ADR-0045 requires of every `<tech>/` folder. */
export const TECH_RESEARCH_FILES = [
  'docs.md',
  'optimizations.md',
  'api-contract.md',
  'scaffold.md',
] as const;
export type TechResearchFile = (typeof TECH_RESEARCH_FILES)[number];

/** The template's default when nothing about the technology suggests otherwise. */
export const DEFAULT_REFRESH_DAYS = 90;

/**
 * Text the template ships with.
 *
 * A folder still containing these was copied and never filled in. Checking for
 * them is crude and it is the only thing that catches the most common way a
 * research folder is wrong — it exists, it is committed, and it says nothing.
 */
export const TEMPLATE_MARKERS = ['<tech>', 'TODO', 'FILL IN', 'lorem ipsum'] as const;

export interface TechDocRecord {
  readonly file: string;
  /** From frontmatter. Absent when the file carries no `researched-on:`. */
  readonly researchedOn?: string | undefined;
  readonly refreshBy?: string | undefined;
  readonly sources: readonly string[];
  /** Body length excluding frontmatter — a sourced file with no prose is not research. */
  readonly bodyChars: number;
  readonly templateMarkers: readonly string[];
}

/**
 * Why a technology's research is not usable.
 *
 * Ordered by how early the problem stops you, and reported as the *first*
 * reason rather than all of them: telling someone their `refresh-by` is stale
 * when the file does not exist is noise.
 */
export const TECH_RESEARCH_STATUSES = [
  'missing',
  'incomplete',
  'undated',
  'unsourced',
  'unsubstantiated',
  'template',
  'stale',
  'current',
] as const;
export type TechResearchStatus = (typeof TECH_RESEARCH_STATUSES)[number];

export interface TechResearchVerdict {
  readonly tech: string;
  readonly status: TechResearchStatus;
  /** The files that produced the verdict. Never a bare status. */
  readonly detail: readonly string[];
  /** Whether code may be written against this technology today. */
  readonly usable: boolean;
}

/** Days between two ISO dates, positive when `to` is later. */
function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return Number.NaN;
  return Math.round((b - a) / 86_400_000);
}

/**
 * Judges one technology's research folder.
 *
 * `today` is a parameter, not `new Date()`. A staleness check that reads the
 * clock cannot be tested at a boundary without waiting for it, and the one day
 * that matters is the one the `refresh-by` date falls on.
 *
 * The `refresh-by` rule is deliberately **inclusive of the day itself**: a doc
 * whose `refresh-by` is today is still current, and stale tomorrow. The
 * alternative — expiring on the date — makes "refresh by the 14th" mean the
 * 13th, which is not what anyone writing the date meant.
 */
export function evaluateTechResearch(
  tech: string,
  docs: readonly TechDocRecord[],
  today: string,
): TechResearchVerdict {
  const verdict = (status: TechResearchStatus, detail: readonly string[]): TechResearchVerdict => ({
    tech,
    status,
    detail,
    usable: status === 'current',
  });

  if (docs.length === 0) {
    return verdict('missing', [
      `no docs/.research/${tech}/ folder — ADR-0045 requires one before code is written against it`,
    ]);
  }

  const present = new Set(docs.map((doc) => doc.file));
  const absent = TECH_RESEARCH_FILES.filter((file) => !present.has(file));
  if (absent.length > 0) {
    return verdict(
      'incomplete',
      absent.map((file) => `${tech}/${file} is missing`),
    );
  }

  const undated = docs.filter(
    (doc) => doc.researchedOn === undefined || doc.refreshBy === undefined,
  );
  if (undated.length > 0) {
    // Without dates there is no refresh clock, so the folder can never go
    // stale — which makes an undated folder permanently "current" and is
    // exactly the loophole the clock exists to close.
    return verdict(
      'undated',
      undated.map((doc) => `${tech}/${doc.file} has no researched-on/refresh-by header`),
    );
  }

  const unsourced = docs.filter((doc) => doc.sources.length === 0);
  if (unsourced.length > 0) {
    return verdict(
      'unsourced',
      unsourced.map(
        (doc) => `${tech}/${doc.file} cites no sources — "I recall it works this way" is not one`,
      ),
    );
  }

  // Cited is not the same as substantiated (P3-RES-02, ADR-0073 §6). A doc whose
  // sources are all tier C rests entirely on pages that report a number without
  // a method — often published by somebody selling the conclusion. That is a
  // lead, not research, and the previous check could not tell the difference
  // because it only counted citations.
  const unsubstantiated = docs
    .map((doc) => ({ doc, quality: assessSources(doc.sources, tech) }))
    .filter((entry) => !entry.quality.substantiated);
  if (unsubstantiated.length > 0) {
    return verdict(
      'unsubstantiated',
      unsubstantiated.map(
        (entry) =>
          `${tech}/${entry.doc.file}: ${entry.quality.findings[0] ?? 'no substantiated source'}`,
      ),
    );
  }

  const templated = docs.filter((doc) => doc.templateMarkers.length > 0 || doc.bodyChars < 200);
  if (templated.length > 0) {
    return verdict(
      'template',
      templated.map((doc) =>
        doc.templateMarkers.length > 0
          ? `${tech}/${doc.file} still contains template text (${doc.templateMarkers.join(', ')})`
          : `${tech}/${doc.file} has ${String(doc.bodyChars)} characters of body — the folder was copied, not filled in`,
      ),
    );
  }

  const expired = docs.filter((doc) => {
    const days = daysBetween(today, doc.refreshBy ?? '');
    return Number.isNaN(days) || days < 0;
  });
  if (expired.length > 0) {
    return verdict(
      'stale',
      expired.map(
        (doc) =>
          `${tech}/${doc.file} was researched ${String(doc.researchedOn)} and expired ${String(doc.refreshBy)} — re-research before reuse (ADR-0045)`,
      ),
    );
  }

  const soonest = docs
    .map((doc) => ({ file: doc.file, days: daysBetween(today, doc.refreshBy ?? '') }))
    .sort((a, b) => a.days - b.days)[0];
  return verdict('current', [
    `${tech}: researched and sourced; next refresh due in ${String(soonest?.days ?? 0)} day(s)`,
  ]);
}

/**
 * The `refresh-by` a research pass should set, given how fast the tech moves.
 *
 * Returned rather than defaulted silently, so the choice is a recorded one. The
 * template's guidance: fast-moving frameworks in major-version churn get 60–90
 * days, spec-level things that rarely change get 6–12 months.
 */
export const REFRESH_CADENCES = {
  churning: 60,
  active: DEFAULT_REFRESH_DAYS,
  stable: 180,
  spec: 365,
} as const;
export type RefreshCadence = keyof typeof REFRESH_CADENCES;

export function refreshByFor(researchedOn: string, cadence: RefreshCadence = 'active'): string {
  const start = Date.parse(`${researchedOn}T00:00:00Z`);
  if (Number.isNaN(start)) throw new Error(`researched-on is not an ISO date: "${researchedOn}"`);
  return new Date(start + REFRESH_CADENCES[cadence] * 86_400_000).toISOString().slice(0, 10);
}
