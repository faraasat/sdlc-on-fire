/**
 * The external-pilot release gate (P2-QA-07, ADR-0064).
 *
 * ADR-0064 exists because dogfooding is incestuous: a tool validated only
 * against itself gets perfectly tuned to its own unusual shape — here, a
 * docs-heavy TypeScript monorepo built by agents with a hand-made harness — and
 * can still fall over on an ordinary project. That gap is how a product becomes
 * demo-ware, and the ADR's answer is a pilot on a real, unrelated repository
 * before the public release.
 *
 * A pilot is a human activity, so the temptation is to record its outcome as a
 * human judgement: *it went well.* That is the one form this must not take. The
 * ADR says the four criteria are "measured, not asserted", and a release gate
 * whose input is somebody's impression of a week is a gate that passes.
 *
 * So each criterion is recorded as an **artifact with an origin**, and the check
 * asks the questions a program can answer:
 *
 * **Is it the same project throughout?** Four criteria attested against three
 * repositories is four half-pilots. The repo is on the report, not on each
 * criterion, and every criterion is stamped with the commit it was observed at.
 *
 * **Is it our project?** The whole point is a repository that is not this one
 * and was not written for the purpose. Checked, because "unrelated" is exactly
 * the property under time pressure that gets satisfied by a repo somebody made
 * on Tuesday.
 *
 * **Did the gate do both halves?** ADR-0063's adoption bar is that the evidence
 * gate blocks a genuinely wrong "done" *and* passes real work. A pilot showing
 * only blocks has demonstrated a gate that says no, which is trivial; one
 * showing only passes has demonstrated nothing at all.
 *
 * **Was the friction captured or dismissed?** Every annoyance becomes a work
 * item. A pilot reporting no friction is not a clean pilot — it is a pilot whose
 * friction went unrecorded, and it is reported as such rather than as success.
 */

export const PILOT_CRITERIA = [
  'init-no-surgery',
  'gate-blocked-wrong-done',
  'gate-passed-real-work',
  'retrieval-narrower-than-dump',
] as const;
export type PilotCriterion = (typeof PILOT_CRITERIA)[number];

/** How an observation was produced. Only one of these is evidence. */
export const OBSERVATION_KINDS = ['command-output', 'assertion'] as const;
export type ObservationKind = (typeof OBSERVATION_KINDS)[number];

export interface PilotObservation {
  readonly criterion: PilotCriterion;
  readonly kind: ObservationKind;
  /** The command run, or the claim made. */
  readonly detail: string;
  /** The commit the pilot repository was at when this was observed. */
  readonly atCommit: string;
}

export interface FrictionItem {
  readonly summary: string;
  /** The work item it became. Friction without one was dismissed, not captured. */
  readonly workItemId?: string | undefined;
}

export interface PilotReport {
  /** The pilot repository — not this one, and not written for the purpose. */
  readonly repository: string;
  readonly maintainer: string;
  readonly observations: readonly PilotObservation[];
  readonly friction: readonly FrictionItem[];
}

export interface PilotFinding {
  readonly criterion: PilotCriterion | 'pilot';
  readonly message: string;
}

export interface PilotVerdict {
  readonly met: readonly PilotCriterion[];
  readonly findings: readonly PilotFinding[];
  /** Whether the public release gate is satisfied. */
  readonly ok: boolean;
}

/** Repository identifiers that are this project rather than a pilot of it. */
export const SELF_MARKERS = ['sdlc-on-fire', 'sdlcof'] as const;

/**
 * Judges a pilot report against ADR-0064's four criteria.
 *
 * `assertion`-kind observations are recorded and **never count**. That is the
 * whole difference between this and a checklist: a pilot can say "init worked",
 * and the gate will read it, print it, and refuse it — because the ADR asked
 * for measured, and "it worked" is the sentence a program cannot check and a
 * person under deadline will always be able to write.
 */
export function evaluatePilot(report: PilotReport): PilotVerdict {
  const findings: PilotFinding[] = [];

  const repository = report.repository.trim().toLowerCase();
  if (repository === '') {
    findings.push({ criterion: 'pilot', message: 'no pilot repository named' });
  } else if (SELF_MARKERS.some((marker) => repository.includes(marker))) {
    findings.push({
      criterion: 'pilot',
      message: `"${report.repository}" is this project — the pilot exists because validating a tool against itself tunes it to its own shape (ADR-0064)`,
    });
  }

  if (report.maintainer.trim() === '') {
    // Named, because "a maintainer willing to report friction honestly" is a
    // pilot criterion and an anonymous one cannot be asked anything afterwards.
    findings.push({ criterion: 'pilot', message: 'no maintainer named on the report' });
  }

  const met: PilotCriterion[] = [];
  for (const criterion of PILOT_CRITERIA) {
    const observations = report.observations.filter((entry) => entry.criterion === criterion);
    const measured = observations.filter((entry) => entry.kind === 'command-output');

    if (observations.length === 0) {
      findings.push({ criterion, message: 'not observed at all' });
      continue;
    }
    if (measured.length === 0) {
      findings.push({
        criterion,
        message:
          'only asserted, never measured — "it worked" is the sentence a program cannot check ' +
          'and a person under deadline can always write (ADR-0064)',
      });
      continue;
    }
    if (measured.some((entry) => entry.atCommit.trim() === '')) {
      findings.push({ criterion, message: 'observed without recording the commit it ran against' });
      continue;
    }
    met.push(criterion);
  }

  // One project, throughout. Four criteria met against three commits of three
  // different states is four half-pilots.
  const commits = new Set(
    report.observations.filter((entry) => entry.kind === 'command-output').map((e) => e.atCommit),
  );
  if (commits.size > 1) {
    findings.push({
      criterion: 'pilot',
      message: `observations span ${String(commits.size)} commits — a pilot is one run of one project, not a best-of`,
    });
  }

  if (report.friction.length === 0) {
    // Not a clean pilot. A real project run by a real person produces friction;
    // a report with none has friction that went unrecorded.
    findings.push({
      criterion: 'pilot',
      message:
        'no friction recorded — a real run produces some, so an empty list means it was dismissed rather than captured (ADR-0064)',
    });
  }

  const dismissed = report.friction.filter(
    (item) => item.workItemId === undefined || item.workItemId.trim() === '',
  );
  if (dismissed.length > 0) {
    findings.push({
      criterion: 'pilot',
      message: `${String(dismissed.length)} friction item(s) with no work item: ${dismissed
        .map((item) => item.summary)
        .join('; ')}`,
    });
  }

  return { met, findings, ok: findings.length === 0 && met.length === PILOT_CRITERIA.length };
}

export function formatPilotVerdict(report: PilotReport, verdict: PilotVerdict): string {
  const lines = [
    `pilot: ${report.repository || '(unnamed)'} — maintainer ${report.maintainer || '(unnamed)'}`,
    '',
  ];

  for (const criterion of PILOT_CRITERIA) {
    const mark = verdict.met.includes(criterion) ? '✓' : '✗';
    lines.push(`  ${mark} ${criterion}`);
  }

  if (verdict.findings.length > 0) lines.push('');
  for (const finding of verdict.findings)
    lines.push(`  ✗ ${finding.criterion}: ${finding.message}`);

  lines.push(
    '',
    verdict.ok
      ? 'Pilot met. The public-release gate this blocks is satisfied (ADR-0064).'
      : 'Pilot not met — the public release stays blocked (ADR-0064, ADR-0063).',
  );
  return lines.join('\n');
}
