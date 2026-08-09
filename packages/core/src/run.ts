import { z } from 'zod';
import { WorkItemIdSchema } from './ids.js';

/**
 * Agent-run record, mirroring the `runs` table in contracts/01-db-schema.md §3.5.
 *
 * A run is daemon-owned state — the CLI and UI never write it directly
 * (contract 01 §1). This schema exists so the daemon and the evidence engine
 * agree on the shape without either importing the other's types.
 */

export const RUN_STATUSES = ['pending', 'running', 'pass', 'fail', 'error'] as const;
export const RunStatusSchema = z.enum(RUN_STATUSES);
export type RunStatus = z.infer<typeof RunStatusSchema>;

/** Statuses after which a run does not change again. */
export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ['pass', 'fail', 'error'];

export function isTerminalRunStatus(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.includes(status);
}

export const RunSchema = z
  .object({
    id: z.string().min(1),
    work_item_id: WorkItemIdSchema,
    skill_id: z.string().min(1).nullable().optional(),
    agent_target: z.string().min(1).nullable().optional(),
    model: z.string().min(1).nullable().optional(),
    /** Path to the daemon-written context-pack audit copy (`.sdlc/context/packs/<run-id>.md`). */
    context_pack_path: z.string().min(1).nullable().optional(),
    status: RunStatusSchema,
    started_at: z.iso.datetime().nullable().optional(),
    finished_at: z.iso.datetime().nullable().optional(),
  })
  .superRefine((run, ctx) => {
    // A finished run that never started, or one that finished before it began,
    // means the daemon's clock handling is wrong — surface it here rather than
    // letting it become a negative duration in the metrics table.
    if (run.finished_at != null && run.started_at == null) {
      ctx.addIssue({
        code: 'custom',
        path: ['started_at'],
        message: 'a run with finished_at must also have started_at',
      });
    }
    if (run.finished_at != null && run.started_at != null) {
      if (Date.parse(run.finished_at) < Date.parse(run.started_at)) {
        ctx.addIssue({
          code: 'custom',
          path: ['finished_at'],
          message: 'finished_at must not precede started_at',
        });
      }
    }
    // Terminal status without a finish time loses the run's duration forever.
    if (isTerminalRunStatus(run.status) && run.finished_at == null) {
      ctx.addIssue({
        code: 'custom',
        path: ['finished_at'],
        message: `status "${run.status}" is terminal and requires finished_at`,
      });
    }
  });

export type Run = z.infer<typeof RunSchema>;
