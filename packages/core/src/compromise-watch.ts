/**
 * Retroactive compromised-package detection (P2-SEC-09, ADR-0033).
 *
 * The install-time gate in P2-SEC-01 answers "is this package safe to add".
 * This answers the question that gate structurally cannot: **is a package
 * already in the tree still safe today.**
 *
 * That gap is not hypothetical. The 2026 incidents ADR-0033 records — Axios
 * backdoored through a hijacked maintainer account, 84 malicious TanStack
 * versions published via Actions cache poisoning, node-ipc, Red Hat Cloud
 * Services, AsyncAPI — were all *real, trusted, already-installed* packages
 * whose publish step was compromised. Not one was a hallucinated name.
 *
 * **A lockfile does not help here, and the reason matters.** Pinning protects
 * against the build silently resolving to something new. It does not protect
 * against a compromised maintainer publishing a version whose hash is perfectly
 * self-consistent — the integrity digest attests that the file has not been
 * altered in transit, not that whoever published it should have. So the only
 * available control is to keep asking: poll the advisory databases against the
 * versions actually installed, and notice when an answer changes.
 *
 * **What changed is the signal, not what is true now.** A poll that reports
 * every known advisory every time produces a wall somebody stops reading. The
 * delta against the last poll is the thing that warrants waking someone.
 */

export interface WatchedPackage {
  readonly name: string;
  readonly version?: string | undefined;
  readonly advisories: readonly string[];
}

export interface WatchRecord {
  /** ISO 8601. When this snapshot was taken. */
  readonly polledAt: string;
  /** Which advisory source answered, so a record from a broken poll is legible. */
  readonly source: string;
  readonly packages: readonly WatchedPackage[];
}

export interface CompromiseFinding {
  readonly name: string;
  readonly version?: string | undefined;
  /** Advisories present now that were not in the previous record. */
  readonly newAdvisories: readonly string[];
  readonly firstSeen: boolean;
}

export interface WatchDelta {
  readonly findings: readonly CompromiseFinding[];
  /** Packages that gained no new advisories. Counted, not listed. */
  readonly unchanged: number;
  /** True when there is no prior record to compare against. */
  readonly baseline: boolean;
}

const keyOf = (pkg: { name: string; version?: string | undefined }): string =>
  `${pkg.name}@${pkg.version ?? '*'}`;

/**
 * What changed since the last poll.
 *
 * **The first run establishes a baseline and says so.** Reporting every
 * existing advisory as "newly discovered" on day one would bury the one that
 * actually appeared on day two, and a tool whose first output is a hundred
 * urgent findings teaches people that its findings are not urgent.
 *
 * A package appearing for the first time *after* a baseline exists is treated
 * as new — it is a dependency added since the last poll, and its advisories
 * have genuinely never been seen by this project.
 */
export function diffWatch(
  previous: WatchRecord | null,
  current: readonly WatchedPackage[],
): WatchDelta {
  if (previous === null) {
    return {
      findings: [],
      unchanged: current.length,
      baseline: true,
    };
  }

  const before = new Map(previous.packages.map((pkg) => [keyOf(pkg), new Set(pkg.advisories)]));
  const findings: CompromiseFinding[] = [];
  let unchanged = 0;

  for (const pkg of current) {
    const known = before.get(keyOf(pkg));
    const newAdvisories = pkg.advisories.filter((id) => known === undefined || !known.has(id));

    if (newAdvisories.length === 0) {
      unchanged += 1;
      continue;
    }

    findings.push({
      name: pkg.name,
      ...(pkg.version === undefined ? {} : { version: pkg.version }),
      newAdvisories,
      firstSeen: known === undefined,
    });
  }

  // Worst first, then stable by name, so two runs over the same state produce
  // the same report.
  return {
    findings: findings.sort(
      (a, b) => b.newAdvisories.length - a.newAdvisories.length || a.name.localeCompare(b.name),
    ),
    unchanged,
    baseline: false,
  };
}

export const COMPROMISE_PLAYBOOK: readonly string[] = [
  'Pin or remove the affected version — do not wait for a fix to be published.',
  'Rotate every credential the affected package could have reached: CI tokens, npm tokens, cloud keys, anything in the environment of a build that ran it.',
  'Check whether a release of your own shipped while the affected version was in the tree; if so, deprecate it.',
  'Read the advisory for the compromise window, then audit what ran inside it — installs are the usual vector, so postinstall scripts and CI logs come first.',
  'Write down what happened and when it was noticed, while it is still fresh.',
];

/**
 * How urgently a finding needs a person.
 *
 * `firstSeen` is deliberately the *lower* severity. A package that appeared in
 * the tree since the last poll carrying an advisory is usually a dependency
 * somebody added and the install-time gate already asked about. An advisory
 * newly attached to a package that was already installed and previously clean
 * is the compromise case: nothing about this project changed, and the answer
 * changed anyway.
 */
export function watchSeverity(finding: CompromiseFinding): 'urgent' | 'review' {
  return finding.firstSeen ? 'review' : 'urgent';
}

export function formatWatchDelta(delta: WatchDelta, source: string): string {
  if (delta.baseline) {
    return [
      `Baseline recorded for ${String(delta.unchanged)} package(s) via ${source}.`,
      '',
      'Nothing is reported on a first run: every advisory that exists today would be',
      'flagged as new, burying the one that appears tomorrow. Run this again — on a',
      'schedule — and the difference is the finding.',
    ].join('\n');
  }

  if (delta.findings.length === 0) {
    return `No new advisories against ${String(delta.unchanged)} installed package(s) via ${source}.`;
  }

  const urgent = delta.findings.filter((f) => watchSeverity(f) === 'urgent');
  const lines = [
    `✗ ${String(delta.findings.length)} package(s) gained advisories since the last poll`,
    '',
  ];

  for (const finding of delta.findings) {
    const where =
      finding.version === undefined ? finding.name : `${finding.name}@${finding.version}`;
    lines.push(
      `  [${watchSeverity(finding).toUpperCase()}] ${where} — ${finding.newAdvisories.join(', ')}${
        finding.firstSeen ? ' (package is new since the last poll)' : ''
      }`,
    );
  }

  if (urgent.length > 0) {
    lines.push(
      '',
      'An advisory newly attached to a package that was already installed means',
      'nothing about this project changed and the answer changed anyway. Response:',
      ...COMPROMISE_PLAYBOOK.map((step, index) => `  ${String(index + 1)}. ${step}`),
    );
  }

  return lines.join('\n');
}
