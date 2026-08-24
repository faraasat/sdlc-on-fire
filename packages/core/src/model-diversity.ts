/**
 * Enforced adversarial diversity (P6-SURFACE-09).
 *
 * A review is worth something because it is a *second opinion*. A model
 * reviewing its own output is not a second opinion — it is the same model
 * asked twice, and it agrees with itself for the same reasons it was wrong the
 * first time. ADR-0026 names diversity collapse as the specific risk;
 * `improvement.ts` already guards it on the mining side and nothing guarded it
 * on the review side.
 *
 * **The check is on the model, not on the agent.** Two differently-named agents
 * on one model are one opinion wearing two hats, and naming is exactly the part
 * that is easy to make look diverse.
 */

export class NoDiverseModelError extends Error {
  override readonly name = 'NoDiverseModelError';
  constructor(
    readonly tier: string,
    readonly excluded: readonly string[],
  ) {
    super(
      `no model available at the "${tier}" tier that did not already work on this item ` +
        `(excluded: ${excluded.join(', ') || 'none'}). ` +
        'A model reviewing its own output is not a second opinion — configure a fallback for this tier, ' +
        'or have a human review it.',
    );
  }
}

export interface DiverseChoice {
  readonly model: string;
  /** True when the primary was skipped because it had already worked on this item. */
  readonly avoided: boolean;
}

/**
 * Picks the first candidate that has not already worked on this item.
 *
 * **Order is preserved and never re-scored.** The candidate list is the tier's
 * preference order — primary first, then fallbacks — and reordering it to
 * "maximise diversity" would silently downgrade the model doing the review. The
 * only thing diversity gets to do is skip.
 *
 * Refuses rather than falling back to the excluded model. A review that
 * announces itself as adversarial and is not is worse than an absent one,
 * because the gate records that a review happened.
 */
export function pickDiverseModel(
  candidates: readonly string[],
  alreadyWorked: readonly string[],
  tier: string,
): DiverseChoice {
  // No filtering of empty entries. A run row with a NULL model reads back as
  // '', and `''` cannot match any candidate: `PinnedModelSchema` requires a
  // non-empty, version-pinned id. A guard here was written and mutation testing
  // showed nothing depended on it — a dead guard reads as a live one, so it is
  // removed rather than tested around.
  const excluded = new Set(alreadyWorked);
  for (const [index, model] of candidates.entries()) {
    if (!excluded.has(model)) return { model, avoided: index > 0 };
  }
  throw new NoDiverseModelError(tier, [...excluded]);
}

/**
 * Stages whose whole purpose is checking somebody else's work.
 *
 * `security_review` is here for the same reason `review` is, and `test` is not:
 * the daemon runs verify and reads the output itself, so there is no second
 * opinion to keep independent.
 */
export const ADVERSARIAL_STAGES = ['review', 'security_review'] as const;

export function needsDiversity(stage: string): boolean {
  return (ADVERSARIAL_STAGES as readonly string[]).includes(stage);
}
