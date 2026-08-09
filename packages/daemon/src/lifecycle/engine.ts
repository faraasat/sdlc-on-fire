import {
  isTerminalStage,
  kanbanColumnForStage,
  LifecycleStageSchema,
  nextStage,
  resolveRequiredStages,
  type KanbanColumn,
  type LifecycleStage,
  type Preset,
} from '@sdlc-on-fire/core';

/**
 * The adaptive lifecycle engine (ADR-0008/ADR-0009, contracts/02 §3).
 *
 * The state machine is **rows, not branches**: legal stages come from
 * `REQUIRED_STAGES` in `core` (mirrored into `lifecycle_states`), and a
 * transition is recorded in `lifecycle_transitions`. There is no `switch` over
 * stage names anywhere in here — adding a stage is a data edit.
 *
 * Guards are named async functions in a registry rather than inline conditions,
 * so a refusal can say *which* guard refused. "Transition denied" with no name
 * is an unactionable error message.
 */

export interface LifecycleStore {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

/** A named precondition on a transition. Returns `null` to allow, or a reason to refuse. */
export type TransitionGuard = (context: GuardContext) => Promise<string | null> | string | null;

export interface GuardContext {
  readonly workItemId: string;
  readonly from: LifecycleStage;
  readonly to: LifecycleStage;
  readonly preset: Preset;
  readonly workType: string;
  readonly store: LifecycleStore;
}

export interface TransitionDenial {
  readonly allowed: false;
  /** Which named guard refused, or a structural reason. */
  readonly guard: string;
  readonly reason: string;
}

export interface TransitionApproval {
  readonly allowed: true;
}

export type TransitionDecision = TransitionApproval | TransitionDenial;

export class UnknownWorkItemError extends Error {
  override readonly name = 'UnknownWorkItemError';
  constructor(readonly workItemId: string) {
    super(`work item ${workItemId} is not in the mirror`);
  }
}

export class TransitionRefusedError extends Error {
  override readonly name = 'TransitionRefusedError';
  constructor(readonly denial: TransitionDenial) {
    super(`transition refused by ${denial.guard}: ${denial.reason}`);
  }
}

interface WorkItemRow {
  id: string;
  lifecycle_state: string;
  work_type: string | null;
  preset: string | null;
}

export interface TransitionInput {
  readonly workItemId: string;
  readonly to: LifecycleStage;
  readonly actorId?: string | null | undefined;
  /** Snapshot of `evaluateGate`'s verdict, recorded with the transition. */
  readonly gateResult?: unknown;
}

export class LifecycleEngine {
  readonly #store: LifecycleStore;
  readonly #guards = new Map<string, TransitionGuard>();

  constructor(store: LifecycleStore) {
    this.#store = store;
  }

  /** Registers a named guard. Later registrations of the same name replace earlier ones. */
  registerGuard(name: string, guard: TransitionGuard): void {
    this.#guards.set(name, guard);
  }

  get guardNames(): string[] {
    return [...this.#guards.keys()].sort();
  }

  async #load(workItemId: string): Promise<WorkItemRow> {
    const rows = await this.#store.query<WorkItemRow>(
      'SELECT id, lifecycle_state, work_type, preset FROM work_items WHERE id = $1;',
      [workItemId],
    );
    const row = rows[0];
    if (row === undefined) throw new UnknownWorkItemError(workItemId);
    return row;
  }

  /**
   * Decides whether a transition is legal, without performing it.
   *
   * Structural checks run before guards: a guard should never be asked about a
   * transition that is not on the item's ladder at all, and running them first
   * would make a nonsense transition fail with a confusing guard name.
   */
  async canTransition(workItemId: string, to: LifecycleStage): Promise<TransitionDecision> {
    const row = await this.#load(workItemId);

    const fromParsed = LifecycleStageSchema.safeParse(row.lifecycle_state);
    if (!fromParsed.success) {
      return {
        allowed: false,
        guard: 'structural:current-stage',
        reason: `current stage "${row.lifecycle_state}" is not in the canonical vocabulary`,
      };
    }
    const from = fromParsed.data;

    if (isTerminalStage(from)) {
      return {
        allowed: false,
        guard: 'structural:terminal',
        reason: `${workItemId} is at terminal stage "${from}"; corrections are new items with supersedes/corrects (ADR-0013)`,
      };
    }

    const preset = (row.preset ?? 'standard') as Preset;
    const workType = row.work_type ?? 'feature';
    const ladder = resolveRequiredStages(preset, workType);

    if (ladder === null) {
      return {
        allowed: false,
        guard: 'structural:ladder',
        reason: `no stage ladder for preset "${preset}" + work_type "${workType}"`,
      };
    }

    if (!ladder.includes(to)) {
      return {
        allowed: false,
        guard: 'structural:ladder',
        reason: `"${to}" is not on this item's ladder (${ladder.join(' → ')})`,
      };
    }

    // Forward-only, one step at a time. Skipping a stage would let an item reach
    // `done` without ever passing the gates attached to the stages in between —
    // which is the entire mechanism this product exists to enforce.
    const expected = nextStage(preset, workType, from);
    if (expected !== to) {
      return {
        allowed: false,
        guard: 'structural:sequence',
        reason: `next stage after "${from}" is "${expected ?? '(none)'}", not "${to}"`,
      };
    }

    for (const [name, guard] of this.#guards) {
      const refusal = await guard({ workItemId, from, to, preset, workType, store: this.#store });
      if (refusal !== null) return { allowed: false, guard: name, reason: refusal };
    }

    return { allowed: true };
  }

  /**
   * Performs a transition, recording it.
   *
   * Refuses rather than clamping: an illegal transition throws with the guard
   * that refused, so the caller learns why instead of silently observing that
   * nothing moved.
   */
  async transition(input: TransitionInput): Promise<void> {
    const decision = await this.canTransition(input.workItemId, input.to);
    if (!decision.allowed) throw new TransitionRefusedError(decision);

    const row = await this.#load(input.workItemId);

    await this.#store.query(
      `INSERT INTO lifecycle_transitions (work_item_id, from_state, to_state, actor_id, gate_result)
       VALUES ($1, $2, $3, $4, $5);`,
      [
        input.workItemId,
        row.lifecycle_state,
        input.to,
        input.actorId ?? null,
        input.gateResult === undefined ? null : JSON.stringify(input.gateResult),
      ],
    );

    // `status` is a projection, so it is derived here rather than accepted from
    // a caller — the write side never targets a Kanban column directly (§3.4).
    await this.#store.query(
      'UPDATE work_items SET lifecycle_state = $1, status = $2, updated_at = now() WHERE id = $3;',
      [input.to, kanbanColumnForStage(input.to), input.workItemId],
    );
  }

  /** Transition history for one item, oldest first. */
  async history(
    workItemId: string,
  ): Promise<{ from: string | null; to: string; createdAt: string }[]> {
    const rows = await this.#store.query<{
      from_state: string | null;
      to_state: string;
      created_at: string;
    }>(
      `SELECT from_state, to_state, created_at FROM lifecycle_transitions
       WHERE work_item_id = $1 ORDER BY id ASC;`,
      [workItemId],
    );
    return rows.map((row) => ({
      from: row.from_state,
      to: row.to_state,
      createdAt: row.created_at,
    }));
  }

  /**
   * Kanban board: a pure `GROUP BY` projection over `lifecycle_state`
   * (contract §3.4). Read-side only — nothing here writes a column.
   */
  async board(): Promise<Record<KanbanColumn, string[]>> {
    const rows = await this.#store.query<{ id: string; lifecycle_state: string }>(
      'SELECT id, lifecycle_state FROM work_items ORDER BY id;',
    );

    const board = {} as Record<KanbanColumn, string[]>;
    for (const row of rows) {
      const stage = LifecycleStageSchema.safeParse(row.lifecycle_state);
      if (!stage.success) continue;
      const column = kanbanColumnForStage(stage.data);
      (board[column] ??= []).push(row.id);
    }
    return board;
  }
}

/**
 * The guard that makes gates load-bearing: a stage with a pending or failed gate
 * does not advance.
 *
 * Registered by the daemon rather than baked into the engine, so the engine
 * stays a pure state machine and the gate coupling is visible at the wiring
 * site (`P1-GATE-02` replaces the stub check with `evaluateGate`).
 */
export function gatesMustPassGuard(): TransitionGuard {
  return async ({ workItemId, from, store }) => {
    const rows = await store.query<{ result: string | null }>(
      'SELECT result FROM gates WHERE work_item_id = $1 AND gate_name = $2;',
      [workItemId, from],
    );
    if (rows.length === 0) return null; // No gate declared for this stage.
    const failing = rows.filter((row) => row.result !== 'pass');
    return failing.length === 0
      ? null
      : `${failing.length} gate(s) on stage "${from}" have not passed`;
  };
}
