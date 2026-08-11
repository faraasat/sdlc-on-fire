import { z } from 'zod';

/**
 * Lifecycle vocabulary and adaptive stage resolution, per
 * contracts/02-object-model.md §3 and ADR-0009 (data-driven state machine).
 *
 * Everything here is **data, not code** (conventions.md): stage sets are object
 * literals mirrored into `lifecycle_stage` / `lifecycle_transition` rows at
 * DB-provisioning time. Adding a work type or reordering a preset's stages is a
 * data edit — never an `if`/`switch` chain.
 */

/** ADR-0008's three discrete rigor presets. Continuous risk scoring was rejected for v1. */
export const PRESETS = ['lite', 'standard', 'strict'] as const;
export const PresetSchema = z.enum(PRESETS);
export type Preset = z.infer<typeof PresetSchema>;

/**
 * The canonical stage vocabulary (contract §3.2). `triage` is the bug-specific
 * alias occupying the same slot as `discovery` rather than a universal rename.
 *
 * `blocked` and `needs_human` are deliberately absent: they are cross-cutting
 * overlays derived from current gate status and rendered as ribbons, never
 * persisted as a `lifecycle_state` value (contract §3.2).
 */
export const LIFECYCLE_STAGES = [
  'intake',
  'discovery',
  'triage',
  'spec',
  'decompose',
  'plan',
  'implement',
  'test',
  'security_review',
  'review',
  'approval',
  'done',
] as const;

export const LifecycleStageSchema = z.enum(LIFECYCLE_STAGES);
export type LifecycleStage = z.infer<typeof LifecycleStageSchema>;

/**
 * Narrows untrusted text to a stage.
 *
 * Frontmatter is user- and agent-authored, so `lifecycle_state` arrives as a
 * plain string. Casting it instead of checking lets a typo behave like a real
 * stage that merely has no successor — which reads as "terminal", the one
 * answer a caller must be able to trust.
 */
export function isLifecycleStage(value: string): value is LifecycleStage {
  return (LIFECYCLE_STAGES as readonly string[]).includes(value);
}

/** `done` is terminal for every `(preset, work_type)` combination (contract §3.2). */
export const TERMINAL_STAGES: readonly LifecycleStage[] = ['done'];

export function isTerminalStage(stage: LifecycleStage): boolean {
  return TERMINAL_STAGES.includes(stage);
}

/**
 * Kanban columns. `status` on a work item is a pure read-side projection over
 * `lifecycle_state` (contract §3.4) — several fine-grained stages may collapse
 * into one column, and the write side never targets a column directly.
 */
export const KANBAN_COLUMNS = [
  'Backlog',
  'Discovery',
  'Spec',
  'Plan',
  'In Progress',
  'Review',
  'Done',
] as const;

export const KanbanColumnSchema = z.enum(KANBAN_COLUMNS);
export type KanbanColumn = z.infer<typeof KanbanColumnSchema>;

/** The projection itself. Total over `LIFECYCLE_STAGES` — a stage with no column is a bug. */
export const STAGE_KANBAN_COLUMN: Record<LifecycleStage, KanbanColumn> = {
  intake: 'Backlog',
  discovery: 'Discovery',
  triage: 'Discovery',
  spec: 'Spec',
  decompose: 'Spec',
  plan: 'Plan',
  implement: 'In Progress',
  test: 'In Progress',
  security_review: 'Review',
  review: 'Review',
  approval: 'Review',
  done: 'Done',
};

/**
 * Derives the Kanban column for a stage. This is the single derivation point for
 * a work item's `status` field, which is why `status` is never independently
 * settable (contract §2.2, §3.4).
 */
export function kanbanColumnForStage(stage: LifecycleStage): KanbanColumn {
  return STAGE_KANBAN_COLUMN[stage];
}

/**
 * `REQUIRED_STAGES[preset][work_type]` (contract §3.3).
 *
 * Keyed by **work_type** — the classification axis — not by work-item *kind*.
 * Contract §1 warns explicitly against conflating the two, and §3.3 types this
 * as `Record<Preset, Record<work_type, string[]>>`.
 *
 * Stages absent from a resolved list have no legal transition edges for that
 * item: "not every story needs every stage" is row-subset absence, never an
 * always-present-but-skippable state.
 *
 * `dependency-upgrade` (P2-LIFE-01) keeps `implement` in every preset even
 * though a bot usually writes the whole diff: a major bump often needs the
 * calling code adapted, and a stage you pass straight through costs less than a
 * stage you cannot enter when you turn out to need it.
 *
 * RESOLVED (ADR-0070, closing contract §8 #3): the table stays keyed on
 * `work_type`, and `task` is a work type — not a second axis. Epics take
 * `new-project`/`existing-codebase` and stories take `feature`/`bug`; only an
 * atomic task lacked a profile, which is why it was the one kind inheriting a
 * feature's full discovery→spec→decompose ladder.
 */
export const REQUIRED_STAGES: Record<Preset, Record<string, readonly LifecycleStage[]>> = {
  lite: {
    task: ['implement', 'done'],
    // `test` is present in *every* preset row for this work type, including
    // lite — where even a plain `task` skips it. That is the whole point of the
    // work type: for a dependency upgrade the diff was written by a bot and
    // nobody is reviewing the library's internals, so the regression evidence
    // *is* the deliverable. What gets dropped instead is discovery/spec/
    // decompose/plan, which is the ceremony that made teams route bot PRs
    // around the process entirely (FEAT-LIFE-001).
    'dependency-upgrade': ['triage', 'implement', 'test', 'done'],
    refactor: ['implement', 'test', 'done'],
    migrate: ['plan', 'implement', 'test', 'review', 'done'],
    bug: ['triage', 'implement', 'done'],
    feature: ['spec', 'implement', 'review', 'done'],
    'new-project': ['discovery', 'spec', 'decompose', 'done'],
    'existing-codebase': ['intake', 'discovery', 'decompose', 'done'],
  },
  standard: {
    task: ['implement', 'test', 'review', 'done'],
    'dependency-upgrade': ['triage', 'implement', 'test', 'review', 'done'],
    refactor: ['implement', 'test', 'review', 'done'],
    // `migrate` keeps `plan` where `refactor` does not: a refactor can be
    // undone with a revert, and a migration that has already run against real
    // data cannot. The plan stage is where the rollback path gets written down
    // while it is still cheap to write.
    migrate: ['plan', 'implement', 'test', 'review', 'done'],
    bug: ['triage', 'plan', 'implement', 'test', 'review', 'done'],
    feature: ['discovery', 'spec', 'decompose', 'plan', 'implement', 'test', 'review', 'done'],
    'new-project': ['intake', 'discovery', 'spec', 'decompose', 'plan', 'review', 'done'],
    'existing-codebase': ['intake', 'discovery', 'spec', 'decompose', 'plan', 'review', 'done'],
  },
  strict: {
    task: ['plan', 'implement', 'test', 'security_review', 'review', 'approval', 'done'],
    // `security_review` is not optional here even though the change is "just a
    // version bump": a dependency upgrade is a supply-chain event, and the
    // 2026 incident record (ADR-0033) is entirely composed of version bumps
    // that looked routine.
    'dependency-upgrade': [
      'triage',
      'implement',
      'test',
      'security_review',
      'review',
      'approval',
      'done',
    ],
    refactor: ['implement', 'test', 'review', 'approval', 'done'],
    migrate: ['plan', 'implement', 'test', 'security_review', 'review', 'approval', 'done'],
    bug: ['triage', 'plan', 'implement', 'test', 'security_review', 'review', 'approval', 'done'],
    feature: [
      'discovery',
      'spec',
      'decompose',
      'plan',
      'implement',
      'test',
      'security_review',
      'review',
      'approval',
      'done',
    ],
    'new-project': [
      'intake',
      'discovery',
      'spec',
      'decompose',
      'plan',
      'security_review',
      'review',
      'approval',
      'done',
    ],
    'existing-codebase': [
      'intake',
      'discovery',
      'spec',
      'decompose',
      'plan',
      'security_review',
      'review',
      'approval',
      'done',
    ],
  },
};

/**
 * Every work type with at least one preset row. `work_type` is an extensible
 * string validated against this registry rather than a closed `z.enum`, because
 * contract §3.1 requires new work types to arrive as a data row, not a code change.
 */
export function knownWorkTypes(): string[] {
  const types = new Set<string>();
  for (const preset of PRESETS) {
    for (const workType of Object.keys(REQUIRED_STAGES[preset])) {
      types.add(workType);
    }
  }
  return [...types].sort();
}

export const WorkTypeSchema = z
  .string()
  .min(1)
  .refine((value) => knownWorkTypes().includes(value), {
    message: 'unknown work_type — add a REQUIRED_STAGES row for it first',
  });

/**
 * Resolves the ordered stage subset for a `(preset, work_type)` pair.
 * Returns `null` for an unregistered pair so callers can report the specific
 * missing row rather than silently falling back to a default ladder.
 */
export function resolveRequiredStages(
  preset: Preset,
  workType: string,
): readonly LifecycleStage[] | null {
  return REQUIRED_STAGES[preset][workType] ?? null;
}

/**
 * Whether `stage` is a legal `lifecycle_state` for this `(preset, work_type)`.
 * The typed writer's invariant (contract §3.3): frontmatter records only the
 * item's *current* stage, and that stage must be a member of its resolved subset.
 */
export function isStageAllowed(preset: Preset, workType: string, stage: LifecycleStage): boolean {
  return resolveRequiredStages(preset, workType)?.includes(stage) ?? false;
}

/**
 * The stage that follows `stage` in this item's resolved subset, or `null` if
 * `stage` is the last one (i.e. terminal for this item) or not in the subset at all.
 *
 * Advancement is gate-governed elsewhere; this only answers "what is next in the
 * ladder", never "may we move".
 */
export function nextStage(
  preset: Preset,
  workType: string,
  stage: LifecycleStage,
): LifecycleStage | null {
  const stages = resolveRequiredStages(preset, workType);
  if (!stages) return null;
  const index = stages.indexOf(stage);
  if (index === -1 || index === stages.length - 1) return null;
  return stages[index + 1] ?? null;
}
