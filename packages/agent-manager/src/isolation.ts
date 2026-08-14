import fs from 'node:fs/promises';
import path from 'node:path';
import type { CanonicalSkill, LifecycleStage, StageHandoff } from '@sdlc-on-fire/core';
import { dispatchSkill, type AgentTransport, type DispatchRequest } from './dispatch.js';
import { acceptHandoff, writeHandoff, type HandoffRejection } from './handoff.js';

/**
 * Fresh-context subagent dispatch (P1-CTX-05).
 *
 * A subagent's value is that it works in its own context window. That value is
 * destroyed the moment its full output is pasted back into the parent's: the
 * parent then pays for every token the subagent read *and* wrote, and two
 * subagents cost more than doing the work inline would have.
 *
 * So an isolated dispatch returns two things and nothing else — a **bounded
 * summary** the parent can reason about, and a **pointer** to the full output on
 * disk for when it genuinely needs the detail. The parent's context grows by a
 * paragraph, not by a transcript.
 *
 * The summary is truncated rather than re-summarised by a second model call.
 * Paying a model to compress another model's output is how a context saving
 * becomes a token cost, and a truncated-with-a-pointer result is honest about
 * being partial in a way a lossy paraphrase is not.
 */

/** Per-stage ceilings on what a subagent may hand back. */
export const STAGE_SUMMARY_BUDGET_CHARS: Readonly<Record<string, number>> = {
  spec: 6_000,
  implement: 8_000,
  review: 8_000,
  retrospective: 2_000,
};

/** Applied to any stage without an explicit entry — 1–2K tokens, roughly. */
export const DEFAULT_SUMMARY_BUDGET_CHARS = 6_000;

/**
 * `undefined` is a situational skill, which has no stage (contract 04 §2.1) and
 * therefore no per-stage budget. It takes the default, same as an unrecognised
 * stage — the fallback already exists for exactly the case of a skill this
 * table has no row for.
 */
export function summaryBudgetFor(stage: string | undefined): number {
  return (
    (stage === undefined ? undefined : STAGE_SUMMARY_BUDGET_CHARS[stage]) ??
    DEFAULT_SUMMARY_BUDGET_CHARS
  );
}

export interface IsolatedResult {
  readonly skill: string;
  /** Bounded — safe to place directly into a parent context. */
  readonly summary: string;
  /** True when `summary` is shorter than the full output. */
  readonly truncated: boolean;
  /** Absolute path to the complete output, for when the detail is actually needed. */
  readonly outputPath: string;
  readonly fullLength: number;
  readonly durationMs: number;
  /**
   * The typed handoff this stage produced (P1-CTX-07), when a boundary was
   * declared and the subagent honoured it.
   *
   * `null` with a `handoffRejection` is the interesting case: the stage ran and
   * produced output, but what it handed the next stage is not consumable. That
   * is a fact the orchestrator must be able to see — a silent fallback to the
   * prose summary is precisely the behaviour ADR-0021 replaced.
   */
  readonly handoff: StageHandoff | null;
  readonly handoffRejection?: HandoffRejection | undefined;
  /** Where the handoff was persisted, when one was accepted. */
  readonly handoffPath?: string | undefined;
}

/** The stage boundary a dispatch is crossing, when it is crossing one. */
export interface HandoffBoundary {
  readonly runId: string;
  readonly workItemId: string;
  readonly from: LifecycleStage;
  readonly to: LifecycleStage;
  /** Workspace state dir (`.sdlcof`) the handoff is written under. */
  readonly stateDir: string;
  /** The preceding boundary, so dropped open questions are caught here. */
  readonly previous?: StageHandoff | undefined;
}

export interface IsolationOptions {
  /** Directory for full outputs. Usually `.sdlcof/runs/<run-id>`. */
  readonly artifactDir: string;
  /** Overrides the per-stage default. */
  readonly summaryBudgetChars?: number | undefined;
  /** Injectable for deterministic file names in tests. */
  readonly runId?: string | undefined;
  /**
   * Declared when this dispatch ends a stage. Absent means "no boundary here",
   * not "handoffs are optional at boundaries".
   */
  readonly boundary?: HandoffBoundary | undefined;
}

function summarise(
  output: Record<string, unknown>,
  budget: number,
): {
  summary: string;
  truncated: boolean;
  fullLength: number;
} {
  const full = JSON.stringify(output, null, 2);
  if (full.length <= budget) return { summary: full, truncated: false, fullLength: full.length };

  // Cut at a line boundary so the summary ends on something readable rather
  // than mid-token, and say plainly that it was cut. A summary that looks
  // complete but isn't is worse than an obviously partial one.
  const clipped = full.slice(0, budget);
  const lastNewline = clipped.lastIndexOf('\n');
  const body = lastNewline > budget / 2 ? clipped.slice(0, lastNewline) : clipped;

  return {
    summary: `${body}\n… truncated (${String(full.length)} chars total; full output on disk)`,
    truncated: true,
    fullLength: full.length,
  };
}

/**
 * Dispatches a skill and returns only what a parent context should absorb.
 *
 * The full output is always written to disk first, before anything is
 * truncated — a summary is not a place to lose data, and a caller that wants
 * the detail must always be able to get it.
 */
export async function dispatchIsolated(
  request: DispatchRequest,
  transport: AgentTransport,
  options: IsolationOptions,
): Promise<IsolatedResult> {
  const result = await dispatchSkill(request, transport);

  await fs.mkdir(options.artifactDir, { recursive: true });
  const outputPath = path.join(
    options.artifactDir,
    `${request.skill.name}-${options.runId ?? String(result.durationMs)}.json`,
  );
  await fs.writeFile(outputPath, JSON.stringify(result.output, null, 2), 'utf8');

  const budget = options.summaryBudgetChars ?? summaryBudgetFor(request.skill.stage);
  const { summary, truncated, fullLength } = summarise(result.output, budget);

  const handoff = await captureHandoff(result.output, options.boundary);

  return {
    skill: result.skill,
    summary,
    truncated,
    outputPath,
    fullLength,
    durationMs: result.durationMs,
    ...handoff,
  };
}

/**
 * Turns a subagent's declared `handoff` field into a validated, persisted one.
 *
 * The stage boundary supplies `runId`/`workItemId`/`from`/`to` rather than
 * trusting the subagent's copy of them: a stage that mislabels which boundary it
 * just crossed would corrupt the chain, and it is the orchestrator, not the
 * subagent, that knows where it dispatched to.
 */
async function captureHandoff(
  output: Record<string, unknown>,
  boundary: HandoffBoundary | undefined,
): Promise<Pick<IsolatedResult, 'handoff' | 'handoffRejection' | 'handoffPath'>> {
  if (boundary === undefined) return { handoff: null };

  const declared = output['handoff'];
  if (declared === undefined) {
    return {
      handoff: null,
      handoffRejection: {
        reason: 'invalid-shape',
        detail: `no "handoff" field in the output of the ${boundary.from} stage`,
      },
    };
  }

  const accepted = acceptHandoff(
    {
      schema_version: '1',
      ...(typeof declared === 'object' && declared !== null ? declared : {}),
      runId: boundary.runId,
      workItemId: boundary.workItemId,
      from: boundary.from,
      to: boundary.to,
    },
    boundary.previous,
  );
  if (!accepted.ok) return { handoff: null, handoffRejection: accepted.rejection };

  const handoffPath = await writeHandoff(boundary.stateDir, accepted.handoff);
  return { handoff: accepted.handoff, handoffPath };
}

/** Whether a skill is declared to run in its own context (`context_mode: fork`). */
export function runsIsolated(skill: CanonicalSkill): boolean {
  return skill.context_mode === 'fork';
}
