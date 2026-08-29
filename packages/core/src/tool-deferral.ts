import type { CanonicalSkill } from './skill.js';

/**
 * Which compiled tools stay loaded, and which wait to be searched for
 * (P2-AGT-02; ADR-0024's deferred condition, met 2026-08-30).
 *
 * **The condition fired because of this phase's own work.** ADR-0024 adopted
 * Tool Search "once the tool registry actually grows large enough to need
 * them", and P2-AGT-01 shipped five tools. The PAYLOAD workstream took that to
 * twenty-one, and `toolBudget` measures the compiled registry at ~8,870 tokens
 * against a 6,000-token trigger. Anthropic's own guidance says to use tool
 * search at "10 or more tools" or "more than 10k tokens" of definitions; we are
 * past the first and near the second.
 *
 * **We do not set `defer_loading` ourselves, and this is why.** For tools that
 * reach a model through the MCP connector, the flag is set on the *consumer's*
 * `mcp_toolset` entry — its `default_config`, or per tool in `configs` — not on
 * the tool definitions a server publishes. So the honest deliverable is not the
 * flag: it is the **plan**, published as data, so whoever writes that config has
 * a defensible answer rather than a guess.
 *
 * Source: platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool,
 * fetched 2026-08-30 (tier A — the vendor's own documentation).
 */

/**
 * How many tools stay loaded. Anthropic's guidance: "keep your 3–5 most
 * frequently used tools non-deferred so Claude can call them without searching
 * first."
 *
 * Five, not three: the standard feature ladder has five stages that dispatch an
 * agent, and cutting below that would make the most ordinary path in the
 * product pay a search it does not need.
 */
export const HOT_TOOL_LIMIT = 5;

export interface DeferralDecision {
  readonly name: string;
  readonly deferred: boolean;
  readonly because: string;
}

export interface DeferralPlan {
  readonly hot: readonly DeferralDecision[];
  readonly deferred: readonly DeferralDecision[];
  readonly because: string;
}

/**
 * Splits the registry into what loads up front and what waits.
 *
 * **The rule is the skill's own trigger, not a usage guess.** A stage skill runs
 * on the ordinary path of every card that reaches its stage; a situational skill
 * runs when a detector says so, and a user-invoked one when somebody asks by
 * name. That is exactly the frequent/long-tail split deferral exists for, and it
 * is already recorded on each skill — so nothing here has to estimate.
 *
 * **The hot set is DECLARED, not derived.** Two derivations were tried and both
 * were deterministic and wrong. Alphabetical order kept `retrospective` — which
 * runs once, when a card ships — and deferred `spec` and `review`. Ladder order
 * then kept the five *earliest* stages and pushed `implement`, the most-used
 * skill in the product, to sixth.
 *
 * The lesson is that "most frequently used" is a measurement, and neither
 * substitute measures it. So it is written down as data, with a reason each, in
 * the same spirit as the stage profiles: reviewable, arguable, and not
 * pretending to a number nobody has.
 *
 * **And the number is now collectable.** P6-INSTRUMENT-02 records a run row per
 * dispatch with `skill_id`; once a workspace has history, `sdlc metrics agents`
 * answers this directly and this list should be checked against it rather than
 * re-argued.
 */
export const HOT_SKILLS: Readonly<Record<string, string>> = {
  implement: 'every card that ships passes through it, usually more than once',
  spec: 'the entry point for feature work, and re-run whenever scope moves',
  review: 'runs on every card that reaches it, and reruns after changes',
  'plan-story': 'the ordinary step between a spec and the work',
  discovery: 'where feature-shaped cards enter the ladder',
};

export function deferralPlan(skills: readonly CanonicalSkill[]): DeferralPlan {
  const declared = Object.keys(HOT_SKILLS);
  const present = new Set(skills.map((skill) => skill.name));
  // Declared names that are actually registered, capped. A name here that no
  // skill answers to is a stale entry, and silently ignoring it would let the
  // list rot into a description of a registry that no longer exists — so the
  // census test asserts every one resolves.
  const hotNames = new Set(declared.filter((name) => present.has(name)).slice(0, HOT_TOOL_LIMIT));

  const decide = (skill: CanonicalSkill): DeferralDecision => {
    if (hotNames.has(skill.name)) {
      return { name: skill.name, deferred: false, because: HOT_SKILLS[skill.name] ?? '' };
    }
    if (skill.stage !== undefined) {
      return {
        name: skill.name,
        deferred: true,
        // Named honestly: this one IS a stage skill and lost on a cap, which is
        // a different reason from "nothing routine dispatches it" and points at
        // a different fix.
        because: 'a stage skill, but not among the few kept loaded',
      };
    }
    if (skill.user_invoked === true) {
      return {
        name: skill.name,
        deferred: true,
        because: 'nothing dispatches it; a person asks for it by name',
      };
    }
    return {
      name: skill.name,
      deferred: true,
      because: `dispatched by the "${String(skill.situation)}" situation, which most changes never hit`,
    };
  };

  const decisions = [...skills].sort((a, b) => a.name.localeCompare(b.name)).map(decide);
  const hot = decisions.filter((decision) => !decision.deferred);

  return {
    hot,
    deferred: decisions.filter((decision) => decision.deferred),
    // At least one tool must stay non-deferred or the API rejects the request
    // outright ("All tools cannot be deferred"). Stated here because the caller
    // writing the config is the one who would hit that 400.
    because:
      hot.length === 0
        ? 'nothing is hot — at least one tool must stay non-deferred or the request is rejected'
        : `${String(hot.length)} tool(s) stay loaded; the rest are found by search when a change needs them`,
  };
}
