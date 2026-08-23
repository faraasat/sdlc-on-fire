import { LIFECYCLE_STAGES, type LifecycleStage } from './lifecycle.js';
import { CONTEXT_LAYER_KINDS, type ContextLayerKind, type EffortTier } from './context.js';

/**
 * Per-stage context-assembly profiles (P6-PERSTAGE-01; FEAT-CTX-003, FEAT-CTX-002).
 *
 * **Data, not code.** The profile table below is an object literal, in the same
 * spirit as `lifecycle.ts`'s preset ladders: changing what the `review` stage
 * gets is a data edit, never a branch added to an assembler. An `if (stage ===
 * 'implement')` inside pack assembly is the thing this exists to prevent, and it
 * is the shape that always grows to eleven branches nobody can hold in mind.
 *
 * **Total over `LIFECYCLE_STAGES`, and a test enforces it.** A stage with no
 * profile would fall back to "everything", which is the least visible way to be
 * wrong: the pack still assembles, the agent still answers, and it answers with
 * discovery notes in front of a one-line fix.
 *
 * **`card-core` is mandatory everywhere and cannot be made optional.** The
 * assembler already refuses to truncate it — an agent handed a partial task
 * description confidently does the wrong thing — so a profile that dropped it
 * would contradict the code that assembles it. Enforced here rather than
 * documented, because the two disagreeing is exactly how a contradiction ships.
 */

/** Layers a stage always gets, if the content exists. */
export type MandatoryLayer = Extract<ContextLayerKind, 'skill-stable' | 'card-core'>;

export interface StageProfile {
  /** Layers included when their content exists. Order comes from `CONTEXT_LAYER_KINDS`. */
  readonly layers: readonly ContextLayerKind[];
  /**
   * Doc types retrieval may return for this stage.
   *
   * An allowlist rather than a denylist. A new doc type appearing in the corpus
   * must be *added* to the stages that want it, not silently reach every stage
   * because nobody remembered to exclude it.
   */
  readonly docTypes: readonly string[];
  /**
   * Path globs retrieval must not return, checked after `docTypes`.
   *
   * The narrow tool: "implementation does not need discovery notes" is a doc
   * type rule, while "nothing under `docs/archive/`" is a path rule, and
   * collapsing them into one mechanism makes both harder to read.
   */
  readonly excludePaths: readonly string[];
  /**
   * Hard ceiling on tokens of **retrieved** content for this stage
   * (P6-PERSTAGE-02, FEAT-CTX-015).
   *
   * Retrieved content only. The mandatory layers are not negotiable — the
   * assembler refuses to truncate `card-core` — so a budget covering everything
   * would either be unenforceable on a large card or would have to start
   * truncating the task description to obey itself.
   *
   * A ceiling, not a target. Nothing tries to fill it; retrieval returns what it
   * returns and this is where it stops.
   */
  readonly retrievalBudget: number;
  /**
   * How much thinking this stage is worth (FEAT-CTX-015, GSD-style low/max).
   *
   * Attached to the **stage**, not to the skill. Two stages can run the same
   * skill and deserve different effort — and a tier on the skill would make
   * `implement` on a typo fix cost what `implement` on a migration costs.
   */
  readonly effortTier: EffortTier;
  /** One line on why this stage's diet is what it is. Shown by `sdlc instructions`. */
  readonly because: string;
}

const ALWAYS: readonly ContextLayerKind[] = ['skill-stable', 'card-core'];
const WITH_STATE: readonly ContextLayerKind[] = ['skill-stable', 'rolling-state', 'card-core'];
const EVERYTHING: readonly ContextLayerKind[] = [...CONTEXT_LAYER_KINDS];

/** Archive is excluded from every stage: a superseded doc read as current is worse than a gap. */
const ARCHIVE = ['docs/archive/**', '**/_archive/**'];

export const STAGE_PROFILES: Readonly<Record<LifecycleStage, StageProfile>> = {
  intake: {
    layers: ALWAYS,
    docTypes: [],
    excludePaths: ARCHIVE,
    retrievalBudget: 0,
    effortTier: 'low',
    because:
      'nothing has been decided yet — retrieval at intake returns prior art as if it were scope',
  },
  discovery: {
    layers: [...WITH_STATE, 'retrieval'],
    docTypes: ['research', 'decision', 'spec'],
    excludePaths: ARCHIVE,
    retrievalBudget: 8000,
    effortTier: 'max',
    because:
      'the widest diet in the ladder: discovery is the stage whose job is to find what exists',
  },
  triage: {
    layers: [...WITH_STATE, 'retrieval'],
    docTypes: ['bug', 'spec'],
    excludePaths: ARCHIVE,
    retrievalBudget: 3000,
    effortTier: 'low',
    because:
      'a bug is triaged against other bugs and the spec it violates, not against the research corpus',
  },
  spec: {
    layers: [...WITH_STATE, 'comment-directives', 'retrieval'],
    docTypes: ['research', 'spec', 'constitution'],
    excludePaths: ARCHIVE,
    retrievalBudget: 6000,
    effortTier: 'max',
    because:
      'the constitution is load-bearing here — a spec that contradicts it is the expensive kind of rework',
  },
  decompose: {
    layers: [...WITH_STATE, 'retrieval'],
    docTypes: ['spec', 'decision'],
    excludePaths: ARCHIVE,
    retrievalBudget: 4000,
    effortTier: 'max',
    because:
      'breaking work up needs the spec and the boundaries, not the research that produced them',
  },
  plan: {
    layers: [...WITH_STATE, 'comment-directives', 'retrieval'],
    docTypes: ['spec', 'decision'],
    excludePaths: ARCHIVE,
    retrievalBudget: 4000,
    effortTier: 'max',
    because: 'sequencing follows from the spec and the architectural decisions that constrain it',
  },
  implement: {
    layers: EVERYTHING,
    // Deliberately no `research`. FEAT-CTX-002's own example: implementation does
    // not need discovery notes, and a pack that carries them spends the budget
    // that should have gone to the code.
    docTypes: ['spec', 'decision', 'constitution'],
    excludePaths: ARCHIVE,
    retrievalBudget: 6000,
    effortTier: 'max',
    because:
      'the spec says what to build and the decisions say what not to break; discovery notes are spent budget',
  },
  test: {
    layers: [...WITH_STATE, 'retrieval'],
    docTypes: ['spec'],
    excludePaths: ARCHIVE,
    // The `test` stage dispatches no agent (the daemon runs verify). The profile
    // exists anyway, because a stage with no profile falls back to everything —
    // and "unreachable today" is not a reason to leave a hole.
    retrievalBudget: 2000,
    effortTier: 'low',
    because:
      'acceptance criteria and nothing else; the daemon runs verify and reads the output itself',
  },
  security_review: {
    layers: [...WITH_STATE, 'retrieval'],
    docTypes: ['decision', 'constitution', 'risk'],
    excludePaths: ARCHIVE,
    retrievalBudget: 5000,
    effortTier: 'max',
    because:
      'threat surface and prior risk records; a security reviewer reading the spec reviews the intent, not the change',
  },
  review: {
    layers: EVERYTHING,
    docTypes: ['spec', 'decision', 'constitution'],
    excludePaths: ARCHIVE,
    retrievalBudget: 6000,
    effortTier: 'max',
    because:
      'review checks the change against what was agreed, so it needs exactly what implement had',
  },
  approval: {
    layers: [...WITH_STATE, 'comment-directives'],
    docTypes: [],
    excludePaths: ARCHIVE,
    retrievalBudget: 0,
    effortTier: 'low',
    because:
      'approval reads evidence, not context — a human signing off needs the gate result, not a retrieval',
  },
  done: {
    layers: [...WITH_STATE, 'retrieval'],
    docTypes: ['decision'],
    excludePaths: ARCHIVE,
    retrievalBudget: 2000,
    effortTier: 'low',
    because:
      'the retrospective looks for what is durable, and a decision is the shape a durable thing takes',
  },
};

export function resolveStageProfile(stage: LifecycleStage): StageProfile {
  return STAGE_PROFILES[stage];
}

/** Every stage names `skill-stable` and `card-core`, whatever else it asks for. */
export function mandatoryLayers(): readonly MandatoryLayer[] {
  return ALWAYS as readonly MandatoryLayer[];
}

/**
 * Whether a retrieved chunk is allowed into this stage's pack.
 *
 * Doc type first, then path. Both must pass — a `spec` under `docs/archive/` is
 * still archived, and a rule that stopped at the type would return it.
 */
export function admitsChunk(
  profile: StageProfile,
  chunk: { readonly docType?: string | undefined; readonly path?: string | undefined },
): boolean {
  // An allowlist: a chunk whose type is unknown is refused rather than admitted.
  // The alternative fails open, and failing open on "what may the agent read" is
  // the wrong direction for a mechanism whose whole job is keeping packs lean.
  if (chunk.docType === undefined || !profile.docTypes.includes(chunk.docType)) return false;
  const chunkPath = chunk.path ?? '';
  return !profile.excludePaths.some((pattern) => matchesGlob(pattern, chunkPath));
}

/**
 * The small glob subset the profiles actually use: `**` and `*`.
 *
 * Hand-rolled rather than a dependency. `minimatch` would bring a transitive
 * tree for two wildcards, and ADR-0045 says research a dependency before use —
 * the research here is that the patterns above are literal prefixes with one
 * wildcard each.
 */
export function matchesGlob(pattern: string, value: string): boolean {
  const escaped = pattern
    .split('**')
    .map((part) =>
      part
        .split('*')
        .map((piece) => piece.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
        .join('[^/]*'),
    )
    .join('.*');
  return new RegExp(`^${escaped}$`).test(value);
}

/** Stages with no profile. Always empty; the test asserts it, and the type nearly does. */
export function stagesWithoutProfile(): readonly string[] {
  return LIFECYCLE_STAGES.filter((stage) => STAGE_PROFILES[stage] === undefined);
}

/**
 * Trims retrieved chunks to a stage's budget (P6-PERSTAGE-02, FEAT-CTX-015).
 *
 * **Enforced, not advised.** The budget existed as a number in `ContextPackSpec`
 * with no per-stage source and nothing that read it per stage; a ceiling nothing
 * applies is a comment. This is where retrieval stops.
 *
 * Chunks are taken **in the order given** — retrieval already ranked them — and
 * the first one that does not fit ends the intake. Not "skip it and try the
 * next": a smaller, worse chunk squeezing past a better one that just missed is
 * how a budget quietly reorders the results, and the ranking is the thing the
 * retriever was for.
 *
 * What was dropped is returned, not discarded. A pack silently missing its
 * best-ranked chunk because of a ceiling is indistinguishable from one where
 * retrieval found nothing, and that difference is exactly what you need when the
 * agent answers badly.
 */
export interface BudgetedChunks<T> {
  readonly admitted: readonly T[];
  readonly dropped: readonly T[];
  readonly tokensUsed: number;
  readonly budget: number;
}

export function applyRetrievalBudget<T extends { readonly tokens: number }>(
  chunks: readonly T[],
  budget: number,
): BudgetedChunks<T> {
  const admitted: T[] = [];
  const dropped: T[] = [];
  let used = 0;

  for (const chunk of chunks) {
    // Once one chunk has been refused, everything after it is refused too. The
    // alternative — keep scanning for something small enough — silently promotes
    // a worse chunk over a better one and calls the result a ranking.
    if (dropped.length > 0 || used + chunk.tokens > budget) {
      dropped.push(chunk);
      continue;
    }
    admitted.push(chunk);
    used += chunk.tokens;
  }

  return { admitted, dropped, tokensUsed: used, budget };
}
