import { z } from 'zod';
import { WorkItemIdSchema } from './ids.js';
import {
  kanbanColumnForStage,
  KanbanColumnSchema,
  LifecycleStageSchema,
  PresetSchema,
  resolveRequiredStages,
  WorkTypeSchema,
} from './lifecycle.js';

/**
 * Work-item taxonomy and frontmatter schemas, per contracts/02-object-model.md
 * §2 and §4.5/§4.6.
 *
 * There is no `card` kind — every Kanban card *is* one of the five kinds below.
 * "Card" is UI vocabulary and never appears in a schema or field name (§2.1).
 */

export const WORK_ITEM_KINDS = ['epic', 'story', 'feature', 'bug', 'task'] as const;
export const WorkItemKindSchema = z.enum(WORK_ITEM_KINDS);
export type WorkItemKind = z.infer<typeof WorkItemKindSchema>;

export const RISK_LEVELS = ['low', 'medium', 'high'] as const;
export const RiskLevelSchema = z.enum(RISK_LEVELS);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

/**
 * Impact classification on a bug, deliberately distinct from `risk_level`
 * (gating strictness). A critical-severity but well-isolated bug is not
 * automatically `risk_level: high` — contract §2.3.
 */
export const BUG_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export const BugSeveritySchema = z.enum(BUG_SEVERITIES);
export type BugSeverity = z.infer<typeof BugSeveritySchema>;

/** Idempotency key for re-runnable imports; never a substitute for the canonical ID (§5.1). */
export const ExternalRefSchema = z.object({
  source_tool: z.string().min(1),
  source_path: z.string().min(1),
  source_id_or_hash: z.string().min(1),
});
export type ExternalRef = z.infer<typeof ExternalRefSchema>;

/**
 * Fields shared by every work-item kind (contract §2.2). Kind-specific schemas
 * extend this; the discriminated union in {@link WorkItemSchema} is the type
 * every consumer should reach for.
 */
export const WorkItemBaseFields = z.object({
  $schema: z.url(),
  id: WorkItemIdSchema,
  kind: WorkItemKindSchema,
  title: z.string().min(1),
  /** Derived from `lifecycle_state`; never independently authored (§2.2, §3.4). */
  status: KanbanColumnSchema,
  lifecycle_state: LifecycleStageSchema,
  work_type: WorkTypeSchema,
  preset: PresetSchema,
  risk_level: RiskLevelSchema.default('low'),
  parent_id: WorkItemIdSchema.nullable().optional(),
  /** Display hint only — authoritative assignment lives in the DB (architecture §5). */
  assignee: z.string().nullable().optional(),
  labels: z.array(z.string()).optional(),
  relates_to: z.array(WorkItemIdSchema).optional(),
  blocks: z.array(WorkItemIdSchema).optional(),
  blocked_by: z.array(WorkItemIdSchema).optional(),
  supersedes: WorkItemIdSchema.nullable().optional(),
  corrects: WorkItemIdSchema.nullable().optional(),
  external_ref: ExternalRefSchema.nullable().optional(),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
});

const EpicFields = WorkItemBaseFields.extend({
  kind: z.literal('epic'),
  goal: z.string().min(1),
  /** Where a mid-lifecycle-inserted epic enters; defaults to the first resolved stage. */
  entry_stage: LifecycleStageSchema.optional(),
});

const StoryFields = WorkItemBaseFields.extend({
  kind: z.literal('story'),
  /** GIVEN/WHEN/THEN, RFC-2119 — mechanically parseable by the Evidence Engine. */
  acceptance_criteria: z.array(z.string().min(1)).min(1),
});

const FeatureFields = WorkItemBaseFields.extend({
  kind: z.literal('feature'),
  spec_ref: z.string().min(1),
  acceptance_criteria: z.array(z.string().min(1)).min(1),
});

const BugFields = WorkItemBaseFields.extend({
  kind: z.literal('bug'),
  repro_steps: z.array(z.string().min(1)).min(1),
  severity: BugSeveritySchema,
});

const TaskFields = WorkItemBaseFields.extend({
  kind: z.literal('task'),
  wave: z.number().int().nonnegative().nullable().optional(),
  /**
   * The command the daemon invokes to produce evidence. Never agent-self-reported
   * — architecture §5 invariant.
   */
  verify: z.string().min(1),
  /** Machine-checkable definition-of-done conditions checked against `verify` output. */
  done: z.array(z.string().min(1)).min(1),
  checkpoint: z.literal('human-verify').nullable().optional(),
  file_ownership: z.array(z.string().min(1)).optional(),
});

/**
 * Cross-field invariants that no single field can express. These are the
 * deterministic disposers (ADR-0040) for work-item validity — a model may
 * propose frontmatter, but this check decides whether it is well-formed.
 */
function checkCrossFieldInvariants(
  item: z.infer<typeof WorkItemBaseFields>,
  ctx: z.RefinementCtx,
): void {
  // `status` is a projection, so an authored value that disagrees with
  // `lifecycle_state` is a conflict, not a preference to honour.
  const expected = kanbanColumnForStage(item.lifecycle_state);
  if (item.status !== expected) {
    ctx.addIssue({
      code: 'custom',
      path: ['status'],
      message: `status must be the projection of lifecycle_state "${item.lifecycle_state}" (expected "${expected}", received "${item.status}")`,
    });
  }

  // A stage outside the item's resolved subset has no transition edges and is
  // therefore unreachable — contract §3.3.
  const stages = resolveRequiredStages(item.preset, item.work_type);
  if (stages && !stages.includes(item.lifecycle_state)) {
    ctx.addIssue({
      code: 'custom',
      path: ['lifecycle_state'],
      message: `lifecycle_state "${item.lifecycle_state}" is not in the resolved stage set for preset "${item.preset}" + work_type "${item.work_type}" (${stages.join(' → ')})`,
    });
  }

  // ADR-0013's link model: both fields are sanctioned ways to change something
  // about a terminal item, but an item declares at most one (contract §5.2).
  if (
    item.supersedes !== null &&
    item.supersedes !== undefined &&
    item.corrects !== null &&
    item.corrects !== undefined
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['corrects'],
      message: 'a work item may set at most one of supersedes / corrects, never both',
    });
  }

  // The ID prefix encodes the kind, so a mismatch means one of the two is wrong
  // and we cannot tell which — reject rather than guess.
  const expectedPrefix = {
    epic: 'EPIC',
    story: 'STORY',
    feature: 'FEAT',
    bug: 'BUG',
    task: 'TASK',
  }[item.kind];
  if (!item.id.startsWith(`${expectedPrefix}-`)) {
    ctx.addIssue({
      code: 'custom',
      path: ['id'],
      message: `id "${item.id}" does not match kind "${item.kind}" (expected prefix "${expectedPrefix}-")`,
    });
  }
}

export const EpicSchema = EpicFields.superRefine(checkCrossFieldInvariants);
export const StorySchema = StoryFields.superRefine(checkCrossFieldInvariants);
export const FeatureSchema = FeatureFields.superRefine(checkCrossFieldInvariants);
export const BugSchema = BugFields.superRefine(checkCrossFieldInvariants);
export const TaskSchema = TaskFields.superRefine(checkCrossFieldInvariants);

/**
 * The canonical work-item schema. Discriminated on `kind`, so a malformed item
 * reports "unrecognized kind" rather than a union-wide error soup.
 */
export const WorkItemSchema = z
  .discriminatedUnion('kind', [EpicFields, StoryFields, FeatureFields, BugFields, TaskFields])
  .superRefine(checkCrossFieldInvariants);

export type Epic = z.infer<typeof EpicSchema>;
export type Story = z.infer<typeof StorySchema>;
export type Feature = z.infer<typeof FeatureSchema>;
export type Bug = z.infer<typeof BugSchema>;
export type Task = z.infer<typeof TaskSchema>;
export type WorkItem = z.infer<typeof WorkItemSchema>;
