/**
 * The adoption bar, computed (P8-BAR-02, ADR-0063, `metrics.md` §3a).
 *
 * ADR-0063 says the measure of this product is not "the gate works":
 *
 * > The gate caught something real the user was glad about within their first
 * > few sessions — and never got in the way when it shouldn't have.
 *
 * `metrics.md` §3a turns that into five signals. This module computes all five
 * from rows and nothing else — no inference, no sentiment, no model.
 *
 * ## Every signal can be `unavailable`, and that is the load-bearing part
 *
 * `sdlc metrics dora` already follows this rule and it matters more here. The
 * difference between *nobody has been blocked yet* and *people are blocked and
 * never glad* is the entire question, and both render as `0%` in a report that
 * cannot say "I don't know". A zero valuable-rate on zero blocks would read as
 * the worst possible result for a product that had simply not been used, and
 * the first thing anybody would do about it is loosen gates that were fine.
 *
 * So a rate is `null` with a reason rather than `0` whenever its denominator is
 * empty — the same discipline as the visibility harness, where a stored rate
 * was rejected in favour of hits and attempts so an interval could always be
 * recomputed.
 *
 * ## Time-to-first-valuable-block is in *blocks*, not days
 *
 * ADR-0063 says "within their first few sessions". Wall-clock time would report
 * a big number for somebody who installed the tool and went on holiday, which
 * says nothing about the product. Counting how many blocks a person hit before
 * the first one they were glad about answers the question actually asked: did
 * the value arrive early enough to survive the friction.
 */

import type { BlockOutcomeTag } from './block-outcome.js';
import { latestTags } from './block-outcome.js';

/** A gate that blocked somebody, in the order the blocks happened. */
export interface BlockRecord {
  readonly gateId: number;
  readonly workItemId: string;
  readonly gateName: string;
  readonly blockedAt: string;
}

/** A config drift observation, as `config_events` stores it. */
export interface ConfigDriftObservation {
  readonly observedAt: string;
  readonly direction: string;
}

export interface Signal {
  /** null when the denominator is empty — never 0. */
  readonly value: number | null;
  readonly numerator: number;
  readonly denominator: number;
  readonly because: string;
}

export interface AdoptionBar {
  readonly valuableRate: Signal;
  readonly nuisanceRate: Signal;
  /** Blocks hit before the first one tagged valuable. null when there has not been one. */
  readonly blocksToFirstValuable: Signal;
  readonly downgradeRate: Signal;
  readonly overrideRate: Signal;
  /** Blocks nobody judged either way — the number that decides how much the rest is worth. */
  readonly untagged: number;
  /**
   * Tags whose gate is not in the block set handed over.
   *
   * Zero in normal use — a tag can only exist on a failed gate, so every tag
   * has a block. It stops being zero the moment a caller scopes the block query
   * (a date window, one work item), and then these are **judgements being
   * silently dropped from the denominator**. Reported rather than ignored,
   * because a rate quietly computed over a subset of the evidence is the
   * failure mode this whole module is written against.
   */
  readonly orphanTags: readonly number[];
  readonly met: boolean | null;
  readonly because: string;
}

function unavailable(because: string): Signal {
  return { value: null, numerator: 0, denominator: 0, because };
}

function rate(numerator: number, denominator: number, because: string): Signal {
  if (denominator === 0) return unavailable(because);
  return { value: numerator / denominator, numerator, denominator, because: '' };
}

export interface AdoptionBarInput {
  readonly blocks: readonly BlockRecord[];
  readonly tags: readonly BlockOutcomeTag[];
  readonly configEvents: readonly ConfigDriftObservation[];
  /** Gate overrides recorded against blocks — `approvals.decision = 'override'`. */
  readonly overrides: number;
}

/**
 * All five signals, plus whether the bar is met.
 *
 * `met` is a tri-state on purpose. `false` means measured and failing — people
 * are being blocked and are not glad about it, which is the abandonment path.
 * `null` means there is not enough data to say, which is a different situation
 * with a different response, and collapsing the two into a boolean would make
 * an unused install indistinguishable from a rejected one.
 */
export function adoptionBar(input: AdoptionBarInput): AdoptionBar {
  const winning = latestTags(input.tags);
  const byGate = new Map(winning.map((tag) => [tag.gateId, tag]));

  const gateIds = new Set(input.blocks.map((block) => block.gateId));
  const orphanTags = winning
    .filter((tag) => !gateIds.has(tag.gateId))
    .map((tag) => tag.gateId)
    .sort((a, b) => a - b);

  const judged = input.blocks.filter((block) => byGate.has(block.gateId));
  const valuable = judged.filter((block) => byGate.get(block.gateId)?.outcome === 'valuable');
  const nuisance = judged.filter((block) => byGate.get(block.gateId)?.outcome === 'nuisance');

  const noJudgements =
    'no block has been judged yet — run `sdlc gates tag <gate-id> valuable|nuisance`';

  const ordered = [...input.blocks].sort(
    (a, b) => Date.parse(a.blockedAt) - Date.parse(b.blockedAt),
  );
  const firstValuableIndex = ordered.findIndex(
    (block) => byGate.get(block.gateId)?.outcome === 'valuable',
  );

  // Count the blocks *up to and including* the first valuable one. Zero would
  // mean "no blocks were needed", which is not a thing that can happen — the
  // first valuable block is itself a block.
  const blocksToFirstValuable: Signal =
    firstValuableIndex === -1
      ? unavailable(
          judged.length === 0
            ? noJudgements
            : 'no block has been judged valuable yet — the bar has not been cleared',
        )
      : {
          value: firstValuableIndex + 1,
          numerator: firstValuableIndex + 1,
          denominator: ordered.length,
          because: '',
        };

  const downgrades = input.configEvents.filter(
    (event) => event.direction === 'weakened' || event.direction === 'mixed',
  ).length;

  const met =
    judged.length === 0
      ? null
      : valuable.length > 0 && nuisance.length <= valuable.length && downgrades === 0;

  return {
    valuableRate: rate(valuable.length, judged.length, noJudgements),
    nuisanceRate: rate(nuisance.length, judged.length, noJudgements),
    blocksToFirstValuable,
    downgradeRate: rate(
      downgrades,
      input.configEvents.length,
      'no config reading has been recorded — run `sdlc config:snapshot`',
    ),
    overrideRate: rate(
      input.overrides,
      input.blocks.length,
      'no gate has blocked anybody yet, so nothing could be overridden',
    ),
    untagged: input.blocks.length - judged.length,
    orphanTags,
    met,
    because:
      met === null
        ? `${String(input.blocks.length)} block(s) recorded, none judged — the bar is unmeasured, which is not the same as unmet`
        : met
          ? `${String(valuable.length)} of ${String(judged.length)} judged block(s) were worth it, and nobody has weakened the gates`
          : 'the bar is not met: ' +
            [
              valuable.length === 0 ? 'no block has been judged valuable' : '',
              nuisance.length > valuable.length
                ? 'more blocks were a nuisance than were worth it'
                : '',
              downgrades > 0 ? `${String(downgrades)} config downgrade(s) observed` : '',
            ]
              .filter((part) => part !== '')
              .join('; '),
  };
}
