import type { GateVerdict } from './evaluate-gate.js';

/**
 * The `ci-repair` entry path (P2-SKILL-05, FEAT-SKILL-021, `.research/techniques/40`).
 *
 * Work normally enters the lifecycle because a person wrote a ticket. This is
 * the other door: **a failed evidence gate opens a work item by itself**, with
 * the tool output as its context pack.
 *
 * `.research/40` calls self-healing CI the most production-mature agentic
 * category found in its sweep — failure wakes a repair agent, it reads the
 * logs, proposes a fix, and the run repeats. The reason it fits here without a
 * new subsystem is that this product already treats tool output as the trust
 * source and already re-opens gates on failure. What was missing is the entry
 * path: the function from "this gate failed" to "here is the work item, scoped
 * to what actually failed".
 *
 * **The failure mode this design is built around.** Asked to make CI green, the
 * cheapest available action is to delete the failing test. That is not a
 * hypothetical an agent has to be talked into; it is the shortest path to the
 * stated goal. So `repairIsLegitimate` is a deterministic check on the repair
 * itself, and it is not advisory — a repair that removed tests or weakened
 * assertions is refused no matter how green the run afterwards.
 */

/**
 * Why the gate failed, which decides what kind of work this is.
 *
 * The three map onto the `GateVerdict` buckets, which already keep them apart
 * for exactly this reason: "nobody ran it", "it ran and failed", and "it ran and
 * could not conclude" need different work, and collapsing them produces a
 * repair agent that tries to fix code when the real problem was a check that
 * never executed.
 */
export type RepairKind = 'run-the-check' | 'fix-the-code' | 'supply-context';

export interface RepairEntry {
  readonly kind: RepairKind;
  /** The checks that put this item here. */
  readonly checks: readonly string[];
  readonly title: string;
  readonly rationale: string;
  /** Which attempt this is, 1-indexed. */
  readonly attempt: number;
}

/**
 * How many times a gate failure may re-open before a person is required.
 *
 * A repair loop with no ceiling is an agent burning tokens against a failure it
 * has already failed to understand twice. Three is a guess, not a measurement,
 * and it is named so the first real data can move it.
 */
export const MAX_REPAIR_ATTEMPTS = 3;

/**
 * The work item a failed gate opens, or `null` when it opens none.
 *
 * `null` for a passing gate, and `null` once the attempt ceiling is reached —
 * the second is not a silent give-up: `repairExhausted` is the caller's signal
 * to escalate, and the two are separate functions so a caller cannot read
 * "nothing to do" out of "this needs a human".
 */
export function repairEntryFor(
  verdict: GateVerdict,
  options: { readonly attempt?: number | undefined; readonly workItemId?: string | undefined } = {},
): RepairEntry | null {
  if (verdict.pass) return null;

  const attempt = options.attempt ?? 1;
  if (attempt > MAX_REPAIR_ATTEMPTS) return null;

  const subject = options.workItemId === undefined ? 'the change' : options.workItemId;

  // Ordered by how much is known, not by severity. A failing check is the most
  // actionable thing on the list — the tool already said what is wrong — so it
  // leads even when evidence is also missing elsewhere.
  if (verdict.failures.length > 0) {
    return {
      kind: 'fix-the-code',
      checks: verdict.failures,
      title: `ci-repair: ${verdict.failures.join(', ')} failing on ${subject}`,
      rationale:
        'A check ran and reported a failure. The tool output is the specification for this work — it says what is wrong, and the fix is to the code, not to the check.',
      attempt,
    };
  }

  if (verdict.missing.length > 0) {
    return {
      kind: 'run-the-check',
      checks: verdict.missing,
      title: `ci-repair: no evidence for ${verdict.missing.join(', ')} on ${subject}`,
      rationale:
        'No qualifying evidence exists for these checks. Nothing is known to be broken — the checks have not run, or ran against a different tree. Run them before changing anything.',
      attempt,
    };
  }

  return {
    kind: 'supply-context',
    checks: verdict.abstained,
    title: `ci-repair: ${verdict.abstained.join(', ')} could not conclude on ${subject}`,
    rationale:
      'The verifier declined to conclude. That is not a failure of the code — it is a failure to give the check enough to work with, and editing the code in response would be changing something that was never shown to be wrong.',
    attempt,
  };
}

/** Whether the ceiling has been reached and a human is now required. */
export function repairExhausted(verdict: GateVerdict, attempt: number): boolean {
  return !verdict.pass && attempt > MAX_REPAIR_ATTEMPTS;
}

export interface TestInventory {
  /** Test file paths present in the tree. */
  readonly files: readonly string[];
  /** How many test cases ran. */
  readonly cases: number;
  /** How many assertions ran, where the runner reports it. */
  readonly assertions?: number | undefined;
  /**
   * Cases the runner reported as skipped, `.only`-scoped or otherwise not run
   * (P3-GATE-10).
   *
   * Counted separately from `cases` because a skipped test is *present* and
   * *not executed*, which is the exact state a suite-shrink check reading only
   * totals cannot see: mark four tests `.skip` and the file count, the case
   * count and the assertion count can all stay flat.
   */
  readonly skipped?: number | undefined;
  /**
   * Whether the runner was scoped to a subset — `.only`, a `-t` filter, a
   * narrowed path argument.
   *
   * A repair that makes the command run less is a repair that made the
   * scoreboard smaller without touching a single test.
   */
  readonly filtered?: boolean | undefined;
  /** Test files the runner matched. A narrowed glob shrinks this silently. */
  readonly matchedFiles?: number | undefined;
}

export interface RepairJudgement {
  readonly legitimate: boolean;
  readonly reasons: readonly string[];
}

/**
 * Whether a repair fixed the code or fixed the scoreboard.
 *
 * Compares the test inventory before and after. This is deliberately not a
 * judgement about the diff's quality — it answers one question, mechanically:
 * did the suite get smaller? A repair that deletes a test, deletes a test file,
 * or drops assertions has made the gate pass without making the software work,
 * and the resulting green run is indistinguishable from a real fix to everything
 * downstream. Which is exactly why it cannot be left to review.
 *
 * Growth is fine and unremarked. Repairs legitimately add regression tests, and
 * treating that as suspicious would discourage the one habit worth encouraging.
 */
export function repairIsLegitimate(before: TestInventory, after: TestInventory): RepairJudgement {
  const reasons: string[] = [];

  const removedFiles = before.files.filter((file) => !after.files.includes(file));
  if (removedFiles.length > 0) {
    reasons.push(`test file(s) removed: ${removedFiles.join(', ')}`);
  }

  if (after.cases < before.cases) {
    reasons.push(
      `test count fell from ${String(before.cases)} to ${String(after.cases)} — a smaller suite is not a passing one`,
    );
  }

  if (
    before.assertions !== undefined &&
    after.assertions !== undefined &&
    after.assertions < before.assertions
  ) {
    // Catches the subtler version: the test still exists and still runs, but
    // the assertion that failed was commented out.
    reasons.push(
      `assertion count fell from ${String(before.assertions)} to ${String(after.assertions)}`,
    );
  }

  // ── P3-GATE-10: the ways a suite shrinks without any count falling ────────
  //
  // The three checks above compare totals, and totals are exactly what the
  // cheapest evasions leave alone. `.skip` keeps the case in the file and out
  // of the run; `.only` keeps every case and runs one; a narrowed glob keeps
  // the whole suite and matches less of it. All three produce a green run over
  // a smaller reality with no number going down.

  const beforeSkipped = before.skipped ?? 0;
  const afterSkipped = after.skipped ?? 0;
  if (afterSkipped > beforeSkipped) {
    reasons.push(
      `skipped tests rose from ${String(beforeSkipped)} to ${String(afterSkipped)} — a skipped test is present and not run, which no total will show`,
    );
  }

  if (after.filtered === true && before.filtered !== true) {
    reasons.push(
      'the run became filtered (`.only`, a name filter, or a narrowed path) — making the command run less is not making the code work',
    );
  }

  if (
    before.matchedFiles !== undefined &&
    after.matchedFiles !== undefined &&
    after.matchedFiles < before.matchedFiles
  ) {
    reasons.push(
      `the runner matched ${String(before.matchedFiles)} files and now matches ${String(after.matchedFiles)} — the suite did not shrink, the net did`,
    );
  }

  return { legitimate: reasons.length === 0, reasons };
}

export function formatRepairEntry(entry: RepairEntry | null): string {
  if (entry === null) return 'gate passed — no repair work opened';

  return [
    `${entry.title} (attempt ${String(entry.attempt)}/${String(MAX_REPAIR_ATTEMPTS)})`,
    `  ${entry.kind}: ${entry.rationale}`,
  ].join('\n');
}

export function formatRepairJudgement(judgement: RepairJudgement): string {
  if (judgement.legitimate) return '✓ the repair did not shrink the suite';

  return [
    '✗ REFUSED — this repair made the gate pass by removing what was checking',
    ...judgement.reasons.map((reason) => `  ${reason}`),
    '',
    'A green run produced this way is indistinguishable from a real fix to',
    'everything downstream, which is why it is refused here rather than left',
    'for review to notice.',
  ].join('\n');
}

/* ------------------------------- security after a repair (P3-QA-09) */

export interface SecurityPosture {
  /** Findings by identifier — advisory ids, rule ids, CWE references. */
  readonly findings: readonly string[];
  /** False when the scan could not run. Distinct from "found nothing". */
  readonly scanned: boolean;
}

export interface SecurityRegression {
  readonly ok: boolean;
  /** Findings the repair introduced. */
  readonly introduced: readonly string[];
  readonly because: string;
}

/**
 * Whether a repair fixed the failing check and opened a security finding
 * (P3-QA-09, `.research/techniques/43` §5).
 *
 * `repairIsLegitimate` asks whether the *suite* shrank. This asks a different
 * question the loop never asked at all: the repair loop re-runs the check that
 * failed, and nothing re-runs the security surface — so a repair that turns a
 * red test green and introduces a CWE passes every gate we have.
 *
 * That is not a hypothetical shape. *Security Degradation in Iterative AI Code
 * Generation* ([arXiv 2506.11022](https://arxiv.org/abs/2506.11022)) reports
 * that repeatedly prompting a model to improve generated code makes its security
 * characteristics **worse**, across multiple models and both prompting
 * strategies — and a repair loop is exactly that, bounded on attempts rather
 * than on security. (The paper's specific figures could not be extracted and are
 * recorded as unverified; the direction is the citable claim.)
 *
 * **An unrunnable scan is not a pass.** If the scan could not run after the
 * repair, this refuses — for the same reason the OSV adapter distinguishes an
 * outage from an all-clear. The absence of a finding and the absence of a look
 * are different facts, and only one of them is reassuring.
 */
export function securityHeldAfterRepair(
  before: SecurityPosture,
  after: SecurityPosture,
): SecurityRegression {
  if (!after.scanned) {
    return {
      ok: false,
      introduced: [],
      because:
        'the security surface was not re-scanned after the repair — no finding and no look are ' +
        'different facts, and only one of them is reassuring (P3-QA-09)',
    };
  }

  if (!before.scanned) {
    // Nothing to compare against. Reported rather than silently treated as a
    // clean baseline, which would make the first repair on any project free.
    return {
      ok: after.findings.length === 0,
      introduced: [...after.findings],
      because:
        after.findings.length === 0
          ? 'no baseline scan, and the post-repair scan is clean'
          : `no baseline to compare against, and the post-repair scan has ${String(after.findings.length)} finding(s) — treated as introduced`,
    };
  }

  const known = new Set(before.findings);
  const introduced = after.findings.filter((finding) => !known.has(finding));

  return {
    ok: introduced.length === 0,
    introduced,
    because:
      introduced.length === 0
        ? 'the repair introduced no new security findings'
        : `the repair turned the check green and introduced ${String(introduced.length)} finding(s): ${introduced.join(', ')}`,
  };
}
