import { z } from 'zod';

/**
 * Package legitimacy classification (P2-SEC-01, `.research/14 §slopcheck`).
 *
 * The failure this exists to stop is **slopsquatting**: a model recommends a
 * package that does not exist, someone registers that exact name, and the next
 * agent installs it without a human ever seeing the name. It is not
 * hypothetical — it is the documented consequence of package hallucination
 * meeting an agent with install permission.
 *
 * **No single signal is sufficient, and that is the whole design.** "New package
 * with few downloads" describes both a typosquat and every legitimate package
 * published this week. `slopcheck`'s multi-signal shape exists precisely because
 * each signal alone has an unusable false-positive rate, and ours copies the
 * shape rather than the thresholds — `.research/14 §risks` is explicit that
 * GSD's numbers should be validated against our own corpus, not assumed to
 * transfer. Ours are therefore stated as what they are: starting values, named
 * and adjustable, not measured on our data.
 *
 * **It fails closed.** When the intel lookup is unavailable, every package is
 * `assumed` rather than `ok`. An offline check that silently passes is worse
 * than no check, because it converts "we did not look" into "we looked and it
 * was fine" — which is the exact substitution this whole product refuses.
 *
 * **The classifier is pure.** Signals in, verdict out, no network and no model
 * ([ADR-0040](docs/.plan/decisions/ADR-0040-llm-proposes-deterministic-disposes.md)):
 * a model may propose a package, but what decides whether it is installable is
 * code you can read.
 */

export const PACKAGE_VERDICTS = ['ok', 'sus', 'slop', 'assumed'] as const;
export const PackageVerdictSchema = z.enum(PACKAGE_VERDICTS);
export type PackageVerdict = z.infer<typeof PackageVerdictSchema>;

/** What the registries say about one package. `undefined` means "not known". */
export const PackageSignalsSchema = z
  .object({
    name: z.string().min(1),
    ecosystem: z.string().min(1),
    version: z.string().optional(),
    /** Days since the package was first published. */
    ageDays: z.number().nonnegative().optional(),
    /** Monthly downloads, as the registry reports them. */
    monthlyDownloads: z.number().nonnegative().optional(),
    /** Whether the registry entry resolves to a real source repository. */
    repositoryVerified: z.boolean().optional(),
    /** Known advisories (CVE/GHSA) against this name and version. */
    advisories: z.array(z.string()).default([]),
    /**
     * A far more popular package within a short edit distance.
     *
     * Socket quantifies typosquatting as 1–2 edits from a package with ≥1000×
     * the monthly downloads, and that ratio is what makes the signal usable:
     * two similarly-sized packages with similar names are a coincidence, but a
     * thousandfold gap is a lure.
     */
    nearestPopularName: z.string().optional(),
    nearestPopularDistance: z.number().int().nonnegative().optional(),
    nearestPopularDownloads: z.number().nonnegative().optional(),
  })
  .strict();

export type PackageSignals = z.infer<typeof PackageSignalsSchema>;

export interface PackageAssessment {
  readonly name: string;
  readonly ecosystem: string;
  readonly verdict: PackageVerdict;
  /** Every signal that fired, in the words a human should read. */
  readonly reasons: readonly string[];
}

/**
 * Starting thresholds. Named, not inlined, because they are guesses.
 *
 * `.research/14 §risks` warns that GSD's own numbers are tuned to its corpus
 * and should not be assumed to transfer. Keeping them here means the day
 * someone measures ours, there is one place to change and one place to cite.
 */
export const RISK_THRESHOLDS = {
  /** Below this, a package has essentially no track record. */
  youngDays: 30,
  /** Below this, nobody is using it — alone, this means very little. */
  lowMonthlyDownloads: 500,
  /** Socket's typosquat definition: within this many edits of a popular name. */
  typosquatDistance: 2,
  /** …and that name has at least this multiple of the downloads. */
  typosquatDownloadRatio: 1000,
} as const;

/** Levenshtein distance — the edit metric the typosquat rule is defined in. */
export function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  let previous = Array.from({ length: cols }, (_, i) => i);

  for (let i = 1; i < rows; i += 1) {
    const current = [i, ...Array.from({ length: cols - 1 }, () => 0)];
    for (let j = 1; j < cols; j += 1) {
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      const deletion = (previous[j] ?? 0) + 1;
      const insertion = (current[j - 1] ?? 0) + 1;
      current[j] = Math.min(substitution, deletion, insertion);
    }
    previous = current;
  }
  return previous[cols - 1] ?? 0;
}

/**
 * Whether these signals describe a typosquat, by Socket's quantified rule.
 *
 * Both halves are required. A near-identical name is only alarming when the
 * thing it resembles is vastly more popular — otherwise `lodash` and `lodash-es`
 * would flag each other forever.
 */
export function looksLikeTyposquat(signals: PackageSignals): boolean {
  const { nearestPopularName, nearestPopularDistance, nearestPopularDownloads } = signals;
  if (nearestPopularName === undefined || nearestPopularName === signals.name) return false;

  const distance = nearestPopularDistance ?? editDistance(signals.name, nearestPopularName);
  if (distance === 0 || distance > RISK_THRESHOLDS.typosquatDistance) return false;

  const mine = signals.monthlyDownloads ?? 0;
  const theirs = nearestPopularDownloads ?? 0;
  return theirs >= Math.max(mine, 1) * RISK_THRESHOLDS.typosquatDownloadRatio;
}

/**
 * Classifies one package.
 *
 * `slop` is reserved for the two findings that are conclusions rather than
 * suspicions: a live advisory against this exact version, and a typosquat by
 * the quantified rule. Everything softer accumulates into `sus`, which flags
 * without striking — because a wrong `slop` deletes a legitimate dependency
 * from a plan, and the cost of that is a developer who stops trusting the tool.
 */
export function classifyPackage(input: PackageSignals): PackageAssessment {
  const signals = PackageSignalsSchema.parse(input);
  const reasons: string[] = [];

  if (signals.advisories.length > 0) {
    reasons.push(
      `known advisory: ${signals.advisories.join(', ')}${
        signals.version === undefined ? '' : ` (at ${signals.version})`
      }`,
    );
  }
  if (looksLikeTyposquat(signals)) {
    reasons.push(
      `name is within ${String(RISK_THRESHOLDS.typosquatDistance)} edits of "${
        signals.nearestPopularName ?? ''
      }", which has at least ${String(RISK_THRESHOLDS.typosquatDownloadRatio)}× the downloads`,
    );
  }
  if (signals.advisories.length > 0 || looksLikeTyposquat(signals)) {
    return { name: signals.name, ecosystem: signals.ecosystem, verdict: 'slop', reasons };
  }

  // Nothing was known at all — the lookup did not happen or returned nothing.
  // That is `assumed`, never `ok`: "we did not look" must not read as "it was
  // fine", which is the substitution this product exists to refuse.
  const knownAnything =
    signals.ageDays !== undefined ||
    signals.monthlyDownloads !== undefined ||
    signals.repositoryVerified !== undefined;
  if (!knownAnything) {
    return {
      name: signals.name,
      ecosystem: signals.ecosystem,
      verdict: 'assumed',
      reasons: ['no registry intelligence available — treated as unverified, not as safe'],
    };
  }

  if (signals.ageDays !== undefined && signals.ageDays < RISK_THRESHOLDS.youngDays) {
    reasons.push(`published ${String(Math.floor(signals.ageDays))} day(s) ago`);
  }
  if (
    signals.monthlyDownloads !== undefined &&
    signals.monthlyDownloads < RISK_THRESHOLDS.lowMonthlyDownloads
  ) {
    reasons.push(`${String(signals.monthlyDownloads)} monthly downloads`);
  }
  if (signals.repositoryVerified === false) {
    reasons.push('registry entry does not resolve to a real source repository');
  }

  return {
    name: signals.name,
    ecosystem: signals.ecosystem,
    // A single soft signal is ordinary for any new package; two together is the
    // shape worth a human's attention. This is the multi-signal rule doing its
    // job rather than a scoring model nobody can audit.
    verdict: reasons.length >= 2 ? 'sus' : 'ok',
    reasons,
  };
}

/**
 * The port the classifier's signals come from.
 *
 * Kept as a port so the offline case is a real, testable state rather than a
 * network failure nobody exercises — and so OSV, deps.dev or a commercial
 * source can be swapped without touching the rule that decides.
 */
export interface PackageIntelPort {
  readonly id: string;
  lookup(
    packages: readonly { name: string; ecosystem: string; version?: string | undefined }[],
  ): Promise<readonly PackageSignals[]>;
}
