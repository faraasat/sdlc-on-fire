/**
 * The web-bundle planning export (P5-ECO-01).
 *
 * A single document somebody pastes into ChatGPT or Gemini when they want to
 * think about their plan somewhere other than an IDE. Built on P4-EXP-01's
 * shape — assemble, declare what was dropped — because the constraint here is
 * the same one in a different currency.
 *
 * **A paste has a ceiling, so this is a budget problem, not a formatting one.**
 * The naive version concatenates every planning artifact and produces something
 * that is silently truncated by whatever it is pasted into — and truncation at
 * the far end is the worst possible failure, because the reader cannot see it
 * happened. So the bundle takes a token budget, fills it in a declared
 * priority order, and **reports every artifact it left out**. A bundle that
 * fits is worth less than a bundle that fits and says what is missing.
 *
 * **Priority is by role in the argument, not by size.** The constitution and
 * the architecture are the things a model cannot infer from the rest; the
 * hundredth story is the thing it can. Dropping from the bottom keeps the
 * bundle interpretable at every budget, which sorting by size would not.
 */

/** What a planning artifact is, ordered by how much a reader loses without it. */
export const BUNDLE_SECTIONS = [
  'constitution',
  'product',
  'architecture',
  'epics',
  'stories',
] as const;
export type BundleSection = (typeof BUNDLE_SECTIONS)[number];

export interface BundleArtifact {
  readonly section: BundleSection;
  readonly title: string;
  readonly body: string;
}

export interface BundleOmission {
  readonly section: BundleSection;
  readonly title: string;
  readonly tokens: number;
  readonly because: string;
}

export interface WebBundle {
  readonly text: string;
  readonly tokens: number;
  readonly budget: number;
  readonly included: number;
  readonly omitted: readonly BundleOmission[];
  /** True when nothing was left out. The only case where the bundle is the whole plan. */
  readonly complete: boolean;
}

/** Four characters per token — the same estimate the context engine uses. */
export function estimate(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Default budget.
 *
 * Deliberately well under any current model's window. The bundle is pasted
 * *into a conversation*, so it shares the window with everything the person
 * then says — a bundle sized to fill the context leaves no room for the
 * question it was assembled to answer.
 */
export const DEFAULT_BUNDLE_BUDGET = 60_000;

const HEADING: Record<BundleSection, string> = {
  constitution: 'Constitution',
  product: 'Product',
  architecture: 'Architecture',
  epics: 'Epics',
  stories: 'Stories',
};

/**
 * Assemble the bundle.
 *
 * Artifacts are taken in section order and, within a section, in the order
 * given — so a caller who has already ranked their stories keeps that ranking.
 * The first artifact that does not fit does not stop the fill: a later, smaller
 * one may still fit, and refusing it because something bigger came first wastes
 * budget for no reason a reader could explain.
 */
export function buildWebBundle(
  artifacts: readonly BundleArtifact[],
  options: { budget?: number; project?: string } = {},
): WebBundle {
  const budget = options.budget ?? DEFAULT_BUNDLE_BUDGET;
  const project = options.project ?? 'this project';

  const header = [
    `# Planning bundle — ${project}`,
    '',
    'Pasted from SDLC on Fire. Everything below is the plan as it stands; nothing',
    'here is a decision made by a model.',
    '',
  ].join('\n');

  const ordered = BUNDLE_SECTIONS.flatMap((section) =>
    artifacts.filter((artifact) => artifact.section === section),
  );

  const parts: string[] = [header];
  const omitted: BundleOmission[] = [];
  let used = estimate(header);
  let included = 0;
  let openSection: BundleSection | null = null;

  for (const artifact of ordered) {
    const heading = artifact.section === openSection ? '' : `## ${HEADING[artifact.section]}\n\n`;
    const block = `${heading}### ${artifact.title}\n\n${artifact.body.trim()}\n\n`;
    const cost = estimate(block);

    if (used + cost > budget) {
      omitted.push({
        section: artifact.section,
        title: artifact.title,
        tokens: cost,
        because: `would take the bundle to ~${String(used + cost)} tokens against a ${String(budget)} budget`,
      });
      continue;
    }

    parts.push(block);
    used += cost;
    included += 1;
    openSection = artifact.section;
  }

  // The omission notice is part of the pasted text, not just the CLI output.
  // Whoever reads the bundle in a chat window is not the person who ran the
  // command, and a truncation they cannot see is the failure this exists to
  // prevent.
  if (omitted.length > 0) {
    const notice = [
      `## Omitted (${String(omitted.length)})`,
      '',
      `This bundle did not fit a ${String(budget)}-token budget. The following were left out,`,
      'lowest-priority first. Ask for any of them by name.',
      '',
      ...omitted.map((entry) => `- ${HEADING[entry.section]} · ${entry.title}`),
      '',
    ].join('\n');
    parts.push(notice);
    used += estimate(notice);
  }

  return {
    text: parts.join(''),
    tokens: used,
    budget,
    included,
    omitted,
    complete: omitted.length === 0,
  };
}
