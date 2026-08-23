/**
 * The research subtypes (P6-PAYLOAD-05, FEAT-SKILL-006).
 *
 * Seven concerns, **one skill**. FEAT-SKILL-006 reads as seven skills and it is
 * the same shape P6-PAYLOAD-02 already resolved for the test tiers: N skills
 * against an M-value vocabulary drifts, and it drifts silently — three tiers
 * with no skill looked exactly like a finished feature. Here the vocabulary is
 * already growing (`techniques/40` proposes tech-debt as an eighth), so seven
 * skills would be seven files to remember and one of them would be missed.
 *
 * The subtype is an argument, and what differs between subtypes is **where you
 * look**, which is data. The *method* is identical across all seven — find
 * primary sources, tier them, say what you could not verify — and that is the
 * part the prompt actually carries.
 *
 * Parallelism is untouched by this. A wave dispatches one skill seven times
 * with seven arguments and seven forked contexts, which is what "runs as a wave
 * instead of one agent context-switching" asked for; it never required seven
 * files.
 */

export const RESEARCH_SUBTYPES = [
  'codebase',
  'package',
  'api',
  'architecture',
  'ui-ux',
  'security',
  'db',
] as const;
export type ResearchSubtype = (typeof RESEARCH_SUBTYPES)[number];

/**
 * Where each subtype's answer actually lives.
 *
 * One line each, compiled into the prompt. The instruction that matters is not
 * "research the database" — it is "read the migrations before you read a blog
 * post about migrations", and that sentence is different for every subtype.
 */
export const RESEARCH_FOCUS: Readonly<Record<ResearchSubtype, string>> = {
  codebase:
    'this repository first — how it already solves the problem, and what a second solution would cost. A pattern already in use beats a better one that would be the third.',
  package:
    "the registry entry, the changelog and the source. Version, maintenance signal and the actual API surface — not a tutorial's version of it, which is usually two majors old.",
  api: "the provider's own reference: auth, rate limits, error shapes, pagination, and what happens at the boundaries. A wrapper library's docs describe the wrapper.",
  architecture:
    'the trade-off, not the pattern name. What each option makes cheap, what it makes expensive, and which of those this project will actually feel.',
  'ui-ux':
    'existing interface conventions and the accessibility requirements that apply. WCAG and the platform HIG are specifications; a design-trends article is not.',
  security:
    'the advisory databases and the vendor advisories, by version. A CVE without an affected-version range is not yet a finding about this project.',
  db: 'the schema, the query plans and the migration path. An index recommendation that has not met the actual cardinality is a guess.',
};
