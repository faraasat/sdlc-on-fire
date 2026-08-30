/**
 * Was the block worth it? (P8-BAR-01, [ADR-0063] the adoption bar.)
 *
 * The product's whole positioning is a gate that will not let an agent lie, and
 * the dominant way a gating product dies is not that the gate is wrong — it is
 * that the gate is *right, mildly annoying, and never catches anything the user
 * cared about*. They drop to `lite`, then they uninstall. ADR-0063 names the
 * bar accordingly, and it is not "the gate works":
 *
 * > The gate caught something real the user was glad about within their first
 * > few sessions — and never got in the way when it shouldn't have.
 *
 * Four of the five signals `metrics.md` §3a specifies are derived from one
 * datum that nothing in this product recorded until now: **when a person was
 * blocked, did they end up glad about it.** No inference produces that. It is
 * the one fact only the person who was stopped can supply.
 *
 * ## Three rules, each structural
 *
 * **Only a block can be tagged.** A gate that passed stopped nobody. Admitting
 * a pass would let the valuable-rate be inflated by rows that were never
 * friction, which is the precise direction a metric like this drifts if you let
 * it.
 *
 * **An agent may never tag.** This is the judgement of whether being stopped
 * was worth it, and an agent tagging its own block *valuable* is the
 * self-report the product exists to refuse — the same rule as *agents are
 * actors, never approvers*, applied to the one question an agent must not
 * answer about itself. Refused here and refused again by a database trigger,
 * because a rule enforced only in the layer that wants to break it is a
 * convention.
 *
 * **A person may change their mind.** Tags append; the latest per actor per
 * gate wins. A block that felt like a nuisance on Tuesday and saved the release
 * on Thursday is real data about gate calibration, and overwriting the first
 * judgement would destroy exactly the thing worth knowing.
 *
 * ## What this module deliberately does not do
 *
 * It does not infer an outcome from anything — not from whether the work later
 * passed, not from how long the block lasted, not from the text of a comment.
 * ADR-0074 declined a sentiment function on measured grounds (sentiment flipped
 * 45.5% of the time against mention's 6.8%), and the reasoning is stronger
 * here: a derived "they seemed happy" would make the one honest number in the
 * adoption bar a model's opinion.
 */

import type { Actor } from './capability.js';

/** The judgement, and there are exactly two. */
export const BLOCK_OUTCOMES = ['valuable', 'nuisance'] as const;
export type BlockOutcome = (typeof BLOCK_OUTCOMES)[number];

/** A gate result as the `gates` table stores it. */
export type GateResult = 'pending' | 'pass' | 'fail';

export interface BlockOutcomeTag {
  readonly gateId: number;
  readonly actorId: string;
  readonly outcome: BlockOutcome;
  /** Free text, deliberately optional — see {@link admitBlockOutcome}. */
  readonly reason: string | null;
  readonly taggedAt: string;
}

export const TAG_REFUSALS = [
  'unknown-outcome',
  'gate-not-a-block',
  'gate-unresolved',
  'agent-actor',
] as const;
export type TagRefusal = (typeof TAG_REFUSALS)[number];

export interface AdmitTagInput {
  readonly gateId: number;
  readonly gateResult: GateResult;
  readonly actor: Actor;
  readonly outcome: string;
  readonly reason?: string | null | undefined;
  readonly now: Date;
}

export type AdmitTagResult =
  | { readonly ok: true; readonly tag: BlockOutcomeTag }
  | { readonly ok: false; readonly refusal: TagRefusal; readonly because: string };

/**
 * Whether this tag may be recorded, and why not when it may not.
 *
 * Every refusal is a *named* one rather than a boolean, because each of the
 * four means something different to the person who hit it and two of them are
 * not mistakes at all: tagging a pending gate is early, and tagging a pass is a
 * misunderstanding of what the metric measures.
 *
 * `reason` is optional on purpose. Requiring prose to record a tag suppresses
 * tags, and for this metric a suppressed tag is worse than an untyped one — the
 * count is the signal and the prose is the colour. An empty or whitespace-only
 * reason normalises to `null` rather than being stored as a string that reads
 * like an answer.
 */
export function admitBlockOutcome(input: AdmitTagInput): AdmitTagResult {
  if (!(BLOCK_OUTCOMES as readonly string[]).includes(input.outcome)) {
    return {
      ok: false,
      refusal: 'unknown-outcome',
      because: `outcome must be one of ${BLOCK_OUTCOMES.join(', ')} — got ${JSON.stringify(input.outcome)}`,
    };
  }
  if (input.actor.kind === 'agent') {
    return {
      ok: false,
      refusal: 'agent-actor',
      because:
        'only a human may judge whether a block was worth it — an agent rating its own block valuable is the self-report this gate exists to refuse',
    };
  }
  if (input.gateResult === 'pending') {
    return {
      ok: false,
      refusal: 'gate-unresolved',
      because: 'the gate has not been evaluated yet, so nobody has been blocked by it',
    };
  }
  if (input.gateResult !== 'fail') {
    return {
      ok: false,
      refusal: 'gate-not-a-block',
      because: 'this gate passed — it stopped nobody, so there is no friction to judge',
    };
  }

  const trimmed = (input.reason ?? '').trim();
  return {
    ok: true,
    tag: {
      gateId: input.gateId,
      actorId: input.actor.id,
      outcome: input.outcome as BlockOutcome,
      reason: trimmed === '' ? null : trimmed,
      taggedAt: input.now.toISOString(),
    },
  };
}

/**
 * The tag that counts, per actor per gate: the most recent one.
 *
 * Ties are broken by input order — the later row wins — because two tags
 * sharing a timestamp came from the same second and the storage order is the
 * only remaining evidence of which was written second. Picking arbitrarily
 * would make a report that is not reproducible from the same rows, which is the
 * property `replayGate` exists to protect elsewhere.
 */
export function latestTags(tags: readonly BlockOutcomeTag[]): readonly BlockOutcomeTag[] {
  const winner = new Map<string, BlockOutcomeTag>();
  for (const tag of tags) {
    const key = `${String(tag.gateId)} ${tag.actorId}`;
    const held = winner.get(key);
    if (held === undefined || Date.parse(tag.taggedAt) >= Date.parse(held.taggedAt)) {
      winner.set(key, tag);
    }
  }
  return [...winner.values()];
}
