/**
 * Dependency-upgrade triage (P2-LIFE-01, FEAT-LIFE-001).
 *
 * External-bot PRs — Dependabot, Renovate — arrive at a rate no team reviews
 * individually, so they get one of two treatments: waved through in bulk, or
 * ignored until something breaks. Both are how a security patch sits unmerged
 * for six weeks next to forty README-badge bumps.
 *
 * Triage sorts them by what is actually different: **why** the bump exists and
 * **how far** it moves. Those two facts are in the PR and the version strings;
 * neither needs a model, and a model asked to decide would produce a different
 * answer for the same input tomorrow.
 *
 * The urgency is a claim about *handling*, never about safety. A `routine`
 * verdict means this can go through the normal queue — not that the package is
 * fine. Whether it is fine is the install gate's question (P2-SEC-01) and the
 * advisory poll's (P2-SEC-09), and neither is short-circuited by anything here.
 */

export type UpgradeUrgency = 'security' | 'major' | 'routine';

export interface UpgradeChange {
  readonly name: string;
  readonly from: string;
  readonly to: string;
  /** Advisory ids the upgrade resolves, when the bot says so. */
  readonly fixesAdvisories?: readonly string[] | undefined;
}

export interface UpgradeTriage {
  readonly urgency: UpgradeUrgency;
  readonly changes: readonly UpgradeChange[];
  readonly breaking: readonly UpgradeChange[];
  readonly reason: string;
  /** True when a human must look before it merges. */
  readonly needsReview: boolean;
}

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)/;

/**
 * Whether a version move crosses a major boundary.
 *
 * `0.x` is treated as major-on-minor, which is what semver actually says and
 * what every team learns the hard way: pre-1.0 packages break on minor bumps by
 * design, and a rule that ignores that waves through the most volatile
 * dependencies in the tree.
 */
export function isBreaking(from: string, to: string): boolean {
  const a = SEMVER.exec(from);
  const b = SEMVER.exec(to);
  // An unparseable version is not evidence of safety. Treated as breaking, so
  // a git dependency or a tag gets a human rather than a shrug.
  if (a === null || b === null) return true;

  const [, fromMajor, fromMinor] = a.map(Number) as [number, number, number, number];
  const [, toMajor, toMinor] = b.map(Number) as [number, number, number, number];

  if (toMajor !== fromMajor) return true;
  if (fromMajor === 0 && toMinor !== fromMinor) return true;
  return false;
}

export function triageUpgrade(changes: readonly UpgradeChange[]): UpgradeTriage {
  const breaking = changes.filter((change) => isBreaking(change.from, change.to));
  const fixing = changes.filter((change) => (change.fixesAdvisories ?? []).length > 0);

  if (changes.length === 0) {
    return {
      urgency: 'routine',
      changes,
      breaking: [],
      reason: 'no dependency changes',
      // An empty change set still needs a human, because a `dependency-upgrade`
      // item with nothing in it means the parser found nothing — not that
      // nothing changed.
      needsReview: true,
    };
  }

  if (fixing.length > 0) {
    const ids = fixing.flatMap((change) => change.fixesAdvisories ?? []);
    return {
      urgency: 'security',
      changes,
      breaking,
      reason: `resolves ${ids.join(', ')}`,
      needsReview: true,
    };
  }

  if (breaking.length > 0) {
    return {
      urgency: 'major',
      changes,
      breaking,
      reason: `${String(breaking.length)} breaking version change(s): ${breaking
        .map((c) => `${c.name} ${c.from}→${c.to}`)
        .join(', ')}`,
      needsReview: true,
    };
  }

  return {
    urgency: 'routine',
    changes,
    breaking: [],
    reason: `${String(changes.length)} compatible version change(s)`,
    // Routine still goes through the work type's `test` stage — that is where
    // the evidence comes from — but it does not need a person's attention
    // before it gets there.
    needsReview: false,
  };
}

/**
 * The order upgrades should be worked in.
 *
 * Security first, then breaking, then routine — and *stable within each band*,
 * so a queue re-sorted twice reads the same both times.
 */
const RANK: Readonly<Record<UpgradeUrgency, number>> = { security: 0, major: 1, routine: 2 };

export function orderByUrgency<T extends { readonly triage: UpgradeTriage; readonly id: string }>(
  items: readonly T[],
): readonly T[] {
  return [...items].sort(
    (a, b) => RANK[a.triage.urgency] - RANK[b.triage.urgency] || a.id.localeCompare(b.id),
  );
}

export function formatTriage(triage: UpgradeTriage): string {
  const lines = [`${triage.urgency.toUpperCase()} — ${triage.reason}`];
  for (const change of triage.changes) {
    const flag = triage.breaking.includes(change) ? ' (breaking)' : '';
    lines.push(`  ${change.name} ${change.from} → ${change.to}${flag}`);
  }
  if (triage.urgency === 'security') {
    lines.push(
      '',
      'A security upgrade is still an upgrade: it goes through the same test stage',
      'as any other. Fixing one advisory by installing a version with a different',
      'one is a real outcome, which is why the install gate still runs.',
    );
  }
  return lines.join('\n');
}
