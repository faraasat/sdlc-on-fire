import { z } from 'zod';

/**
 * ID schemes, per contracts/02-object-model.md §5.1. Two schemes coexist
 * deliberately and are never unified: this repo's own build-plan task IDs
 * (`P0-OBJ-01`) are assigned by a human at planning time and never appear in a
 * managed workspace, while `.sdlc/` work-item IDs are assigned by the tool at
 * creation and never reused.
 */

/** Zero-padded sequence width for work-item and insertion IDs. */
const SEQUENCE_WIDTH = 3;

/**
 * Per-kind ID prefix. `feature` is deliberately abbreviated to `FEAT` — the
 * contract fixes the prefix, not a mechanical uppercase of the kind.
 */
export const WORK_ITEM_ID_PREFIX = {
  epic: 'EPIC',
  story: 'STORY',
  feature: 'FEAT',
  bug: 'BUG',
  task: 'TASK',
} as const satisfies Record<string, string>;

export type WorkItemIdPrefix = (typeof WORK_ITEM_ID_PREFIX)[keyof typeof WORK_ITEM_ID_PREFIX];

const PREFIX_ALTERNATION = Object.values(WORK_ITEM_ID_PREFIX).join('|');

/** `EPIC-001`, `STORY-014`, `FEAT-007`, `BUG-042`, `TASK-113`. */
export const WORK_ITEM_ID_PATTERN = new RegExp(
  `^(?:${PREFIX_ALTERNATION})-\\d{${SEQUENCE_WIDTH},}$`,
);

/** `ADR-0013-immutable-completed-work` — four-digit sequence, kebab-case slug. */
export const ADR_ID_PATTERN = /^ADR-\d{4}-[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** `INSERT-014` — assigned by the daemon's Insertion Engine, never reused. */
export const INSERTION_ID_PATTERN = new RegExp(`^INSERT-\\d{${SEQUENCE_WIDTH},}$`);

export const WorkItemIdSchema = z
  .string()
  .regex(WORK_ITEM_ID_PATTERN, 'must be a type-prefixed work-item ID, e.g. STORY-014');

export const AdrIdSchema = z
  .string()
  .regex(ADR_ID_PATTERN, 'must be an ADR ID, e.g. ADR-0013-immutable-completed-work');

export const InsertionIdSchema = z
  .string()
  .regex(INSERTION_ID_PATTERN, 'must be an insertion ID, e.g. INSERT-014');

/**
 * Formats a work-item ID from its kind and sequence number. The tool is the only
 * assigner of these IDs (contract §5.1) — this is that assignment point, so
 * nothing else should be constructing the string by hand.
 *
 * Sequences beyond the padding width widen rather than truncate: item 1000 is
 * `TASK-1000`, not `TASK-000`.
 */
export function formatWorkItemId(kind: keyof typeof WORK_ITEM_ID_PREFIX, sequence: number): string {
  if (!Number.isInteger(sequence) || sequence < 1) {
    throw new RangeError(`work-item sequence must be a positive integer, received ${sequence}`);
  }
  return `${WORK_ITEM_ID_PREFIX[kind]}-${String(sequence).padStart(SEQUENCE_WIDTH, '0')}`;
}

/**
 * Inverse of {@link formatWorkItemId}. Returns `null` rather than throwing for a
 * malformed ID, so callers scanning a directory of files can skip non-conforming
 * names without exception handling in the hot path.
 */
export function parseWorkItemId(
  id: string,
): { kind: keyof typeof WORK_ITEM_ID_PREFIX; sequence: number } | null {
  const match = /^([A-Z]+)-(\d+)$/.exec(id);
  if (!match) return null;
  const [, prefix, digits] = match;
  const entry = Object.entries(WORK_ITEM_ID_PREFIX).find(([, value]) => value === prefix);
  if (!entry || digits === undefined) return null;
  return {
    kind: entry[0] as keyof typeof WORK_ITEM_ID_PREFIX,
    sequence: Number.parseInt(digits, 10),
  };
}
