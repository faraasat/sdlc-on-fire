/**
 * Database-migration planning (P2-SKILL-06, FEAT-SKILL-022, `.research/techniques/32 §2.3`).
 *
 * Expand-contract is a decades-old pattern and this adds nothing to it. What it
 * adds is a *checker*: the pattern's whole value is in doing the three phases
 * separately, and the failure is always the same — somebody does expand and
 * contract in one migration because the intermediate state felt like
 * bureaucracy, and the deploy that drops the old column races the deploy that
 * stopped writing to it.
 *
 * **The asymmetry the gate exists for.** Expand adds structure: reversible.
 * Backfill copies data: reversible. **Contract destroys data, and no amount of
 * planning makes `DROP COLUMN` undoable.** A `migrate` work item can be
 * rolled back right up until its contract phase, and not one step after — so
 * contract is held to a different standard than the other two, and the checker
 * is where that difference lives rather than in a paragraph somebody read once.
 *
 * Pairs with the `migrate` work type (P2-LIFE-02), which already forces full
 * regression regardless of what the diff touched and keeps a `plan` stage in
 * every preset for exactly this.
 */

export const MIGRATION_PHASES = ['expand', 'backfill', 'contract'] as const;
export type MigrationPhase = (typeof MIGRATION_PHASES)[number];

/**
 * Backfill batching bounds.
 *
 * `.research/32` cites 1k–10k rows per batch with brief pauses. The lower bound
 * matters as much as the upper: a batch of 50 turns a ten-minute backfill into
 * an overnight one, and a backfill still running the next morning is one
 * somebody kills halfway — leaving the table in the half-migrated state the
 * whole pattern exists to make safe *temporarily*, not permanently.
 */
export const BACKFILL_BOUNDS = {
  minBatch: 1_000,
  maxBatch: 10_000,
  /** Milliseconds. Zero pause is a backfill that starves the application. */
  minPauseMs: 50,
} as const;

export interface MigrationPlan {
  readonly phase: MigrationPhase;
  /** What the migration does, in one line, for the reviewer. */
  readonly summary: string;
  /** How to undo it. Required for expand and backfill; impossible for contract. */
  readonly rollback?: string | undefined;
  readonly batchSize?: number | undefined;
  readonly pauseMs?: number | undefined;
  /**
   * For contract only: evidence that nothing still reads the old structure.
   * A date, a query, a dashboard — something checkable, not a belief.
   */
  readonly unreferencedEvidence?: string | undefined;
  /** For contract only: the expand work item this contracts. */
  readonly expandedIn?: string | undefined;
  /**
   * Row count the timing was measured against.
   *
   * `.research/32`: dev-DB timing is not representative. A migration timed
   * against 200 seeded rows tells you nothing about the 40 million in
   * production, and the number nobody wrote down is the number nobody measured.
   */
  readonly measuredAgainstRows?: number | undefined;
}

export interface PlanFinding {
  readonly severity: 'blocking' | 'review';
  readonly message: string;
}

export interface PlanVerdict {
  readonly phase: MigrationPhase;
  readonly findings: readonly PlanFinding[];
  readonly ready: boolean;
}

const MIN_ROLLBACK = 12;

/**
 * Checks a migration plan.
 *
 * Two severities, because they are genuinely different questions. `blocking`
 * means the plan is missing something the pattern requires — that is
 * mechanical. `review` means a number looks wrong for reasons that depend on
 * the table, and only a person knows the table.
 */
export function validateMigrationPlan(plan: MigrationPlan): PlanVerdict {
  const findings: PlanFinding[] = [];
  const add = (severity: PlanFinding['severity'], message: string): void => {
    findings.push({ severity, message });
  };

  if (plan.summary.trim().length < MIN_ROLLBACK) {
    add('blocking', 'no summary — a reviewer cannot approve a migration nobody described');
  }

  if (plan.phase === 'contract') {
    // Rollback is not requested here, deliberately. Asking for one invites an
    // answer, and any answer would be false: the data is gone. Naming that is
    // more useful than a field somebody fills in with "restore from backup".
    if (plan.rollback !== undefined && plan.rollback.trim() !== '') {
      add(
        'review',
        'a rollback is described for a contract phase — dropping structure destroys data, and a plan that implies otherwise is worth a second read',
      );
    }
    if ((plan.unreferencedEvidence ?? '').trim().length < MIN_ROLLBACK) {
      add(
        'blocking',
        'no evidence the old structure is unreferenced — contract is the irreversible step, and "we think nothing uses it" is not a finding',
      );
    }
    if ((plan.expandedIn ?? '').trim() === '') {
      add(
        'blocking',
        'no expand phase referenced — a contract with no prior expand is a destructive change wearing the pattern’s name',
      );
    }
  } else if ((plan.rollback ?? '').trim().length < MIN_ROLLBACK) {
    add(
      'blocking',
      `no rollback for the ${plan.phase} phase — this one is reversible, which is the only reason it is safe to run first`,
    );
  }

  if (plan.phase === 'backfill') {
    const batch = plan.batchSize;
    if (batch === undefined) {
      add('blocking', 'no batch size — an unbatched backfill locks the table for its whole run');
    } else if (batch > BACKFILL_BOUNDS.maxBatch) {
      add(
        'review',
        `batch of ${String(batch)} exceeds ${String(BACKFILL_BOUNDS.maxBatch)} — long transactions hold locks and bloat replication lag`,
      );
    } else if (batch < BACKFILL_BOUNDS.minBatch) {
      add(
        'review',
        `batch of ${String(batch)} is below ${String(BACKFILL_BOUNDS.minBatch)} — a backfill still running the next morning is one somebody kills halfway`,
      );
    }

    if ((plan.pauseMs ?? 0) < BACKFILL_BOUNDS.minPauseMs) {
      add('review', 'no pause between batches — a backfill at full speed starves the application');
    }

    if (plan.measuredAgainstRows === undefined) {
      add(
        'blocking',
        'timing was not measured against a row count — dev-DB timing is not representative, and the number nobody wrote down is the number nobody measured',
      );
    }
  }

  return {
    phase: plan.phase,
    findings,
    ready: !findings.some((finding) => finding.severity === 'blocking'),
  };
}

/**
 * Whether a set of plans does the three phases separately.
 *
 * The failure this catches is the one that motivates the whole pattern: expand
 * and contract landing in one migration, so there is no window in which both
 * the old and new structure work. The intermediate state is not overhead — it
 * is the entire mechanism.
 */
export function phasesAreSeparate(plans: readonly MigrationPlan[]): PlanFinding[] {
  const phases = new Set(plans.map((plan) => plan.phase));
  if (phases.has('expand') && phases.has('contract')) {
    return [
      {
        severity: 'blocking',
        message:
          'expand and contract in the same change — there is then no deploy in which both the old and new structure work, which is the one thing expand-contract is for',
      },
    ];
  }
  return [];
}

export function formatPlanVerdict(verdict: PlanVerdict): string {
  const lines = [
    verdict.ready
      ? `✓ ${verdict.phase} plan is complete`
      : `✗ ${verdict.phase} plan is not ready to run`,
  ];
  for (const finding of verdict.findings) {
    lines.push(`  [${finding.severity}] ${finding.message}`);
  }
  if (verdict.phase === 'contract' && verdict.ready) {
    lines.push(
      '',
      'This is the irreversible phase. Everything before it could be rolled back;',
      'from here the old data is gone.',
    );
  }
  return lines.join('\n');
}
