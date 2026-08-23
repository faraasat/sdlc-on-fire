/**
 * Governance-side measures (P6-INSTRUMENT-04; FEAT-MET-015/014/004/009).
 *
 * Arithmetic over rows, in `core` and away from SQL, so it is tested against
 * data rather than against a database.
 *
 * **Every measure here reports `null` rather than a flattering zero.** A gate
 * policy with no evaluations and one that never passed both produce "0% pass"
 * from a naive implementation, and the first is an absence while the second is
 * an emergency.
 */

/**
 * A gate as this report reads it.
 *
 * Named `GateEvaluation`, not `GateRow` — `evidence-binding.ts` already exports
 * a `GateRow` with a different shape, and two types one word apart describing
 * the same table is the vocabulary split this repo has found five times.
 */
export interface GateEvaluation {
  readonly workItemId: string;
  readonly gateName: string;
  readonly result: string | null;
  /** The role the policy required, or `null` when no policy applied. */
  readonly requiredRole: string | null;
  readonly policyId: number | null;
}

export interface GatePassRate {
  /** `<policy id or "none">/<required role or "none">`, so the two are never conflated. */
  readonly key: string;
  readonly gateName: string;
  readonly evaluated: number;
  readonly passed: number;
  readonly failed: number;
  readonly pending: number;
  /**
   * `passed / (passed + failed)`, or `null` when nothing has been decided.
   *
   * Pending gates are excluded from the denominator rather than counted as
   * failures. A gate raised five minutes ago has not failed; folding it in makes
   * a healthy policy look strict precisely when work is in flight.
   */
  readonly passRate: number | null;
}

export interface ApprovalRow {
  readonly actorKind: string;
  readonly decision: string;
  readonly revokedAt: string | null;
  readonly createdAt: string;
}

export interface HumanInterventions {
  readonly approvals: number;
  readonly rejections: number;
  /** Approvals later taken back. The number that says a gate is being clicked through. */
  readonly revocations: number;
  /** Agent-authored approvals, which the schema refuses — a non-zero here is a bug, not a metric. */
  readonly agentApprovals: number;
}

export interface InsertionRow {
  readonly id: string;
  readonly into: string;
  readonly state: string;
  readonly recordedAt: string;
}

export interface InsertionFrequency {
  readonly total: number;
  readonly approved: number;
  readonly rejected: number;
  readonly proposed: number;
  /** Insertions per 30 days over the observed span, or `null` with under two records. */
  readonly perThirtyDays: number | null;
  /**
   * Containers that absorbed the most insertions.
   *
   * The displacement half of FEAT-MET-014. Which container kept growing is the
   * factual read on scope churn; a bare count says churn happened and not where.
   */
  readonly byContainer: readonly { readonly into: string; readonly insertions: number }[];
}

export function gatePassRates(rows: readonly GateEvaluation[]): readonly GatePassRate[] {
  const groups = new Map<string, { gateName: string; rows: GateEvaluation[] }>();
  for (const row of rows) {
    // Policy and role are both in the key. Two policies requiring the same role
    // are two policies, and merging them hides which one is the strict one —
    // which is the question FEAT-MET-015 exists to answer.
    const key = `${row.policyId === null ? 'none' : String(row.policyId)}/${row.requiredRole ?? 'none'}`;
    const group = groups.get(key) ?? { gateName: row.gateName, rows: [] };
    group.rows.push(row);
    groups.set(key, group);
  }

  return [...groups.entries()]
    .map(([key, group]) => {
      const passed = group.rows.filter((row) => row.result === 'pass').length;
      const failed = group.rows.filter((row) => row.result === 'fail').length;
      const decided = passed + failed;
      return {
        key,
        gateName: group.gateName,
        evaluated: group.rows.length,
        passed,
        failed,
        pending: group.rows.filter((row) => row.result === 'pending' || row.result === null).length,
        passRate: decided === 0 ? null : passed / decided,
      };
    })
    .sort((a, b) => b.evaluated - a.evaluated || a.key.localeCompare(b.key));
}

export function humanInterventions(rows: readonly ApprovalRow[]): HumanInterventions {
  const human = rows.filter((row) => row.actorKind === 'human');
  return {
    approvals: human.filter((row) => row.decision === 'approve').length,
    rejections: human.filter((row) => row.decision !== 'approve').length,
    revocations: human.filter((row) => row.revokedAt !== null).length,
    // Counted, and it should always be zero: the schema refuses an agent
    // approval outright (ADR-0010). A non-zero here is a broken invariant
    // surfacing as a number, which is the cheapest place to notice one.
    agentApprovals: rows.filter((row) => row.actorKind === 'agent' && row.decision === 'approve')
      .length,
  };
}

const THIRTY_DAYS = 30 * 24 * 3_600_000;

export function insertionFrequency(rows: readonly InsertionRow[]): InsertionFrequency {
  const times = rows
    .map((row) => Date.parse(row.recordedAt))
    .filter((time) => !Number.isNaN(time))
    .sort((a, b) => a - b);
  const first = times[0];
  const last = times[times.length - 1];
  // A rate needs a span, and one record has none. Reporting "1 per 30 days" off
  // a single insertion is an extrapolation from a sample of one wearing the
  // clothes of a measurement.
  const spanMs = times.length < 2 || first === undefined || last === undefined ? 0 : last - first;

  const byContainer = new Map<string, number>();
  for (const row of rows) byContainer.set(row.into, (byContainer.get(row.into) ?? 0) + 1);

  return {
    total: rows.length,
    approved: rows.filter((row) => row.state === 'approved').length,
    rejected: rows.filter((row) => row.state === 'rejected').length,
    proposed: rows.filter((row) => row.state !== 'approved' && row.state !== 'rejected').length,
    perThirtyDays: spanMs <= 0 ? null : (rows.length / spanMs) * THIRTY_DAYS,
    byContainer: [...byContainer.entries()]
      .map(([into, insertions]) => ({ into, insertions }))
      .sort((a, b) => b.insertions - a.insertions || a.into.localeCompare(b.into)),
  };
}

/**
 * PR duration (FEAT-MET-009) — **not available, and this says why.**
 *
 * The product records that a PR was opened (`runs.pr_url`) and when the run that
 * opened it finished. It does not record when the PR merged or closed, because
 * nothing in the workspace observes that: the merge happens on the forge.
 *
 * Returned as a typed absence rather than omitted from the report. A governance
 * section that silently lacks PR duration reads as "PRs are not slow", and the
 * whole discipline here is that an unmeasured thing says so.
 */
export interface PrDuration {
  readonly available: false;
  readonly because: string;
}

export const PR_DURATION_UNAVAILABLE: PrDuration = {
  available: false,
  because:
    'the workspace records when a PR was opened, not when it merged — merge time lives on the forge, and reading it needs the tracker sync (P5-TRACK-01) pointed at the repository',
};

export interface GovernanceMetrics {
  readonly gates: readonly GatePassRate[];
  readonly interventions: HumanInterventions;
  readonly insertions: InsertionFrequency;
  readonly prDuration: PrDuration;
}
