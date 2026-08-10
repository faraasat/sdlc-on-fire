import fs from 'node:fs/promises';
import path from 'node:path';
import {
  StageHandoffSchema,
  handoffProblems,
  type LifecycleStage,
  type StageHandoff,
} from '@sdlc-on-fire/core';

/**
 * Writing and reading stage handoffs (P1-CTX-07, ADR-0021).
 *
 * {@link dispatchIsolated} returns a bounded free-text summary — the right size,
 * the wrong shape. This is the typed replacement: the subagent's declared output
 * carries a handoff object, we validate it, and the next stage reads fields
 * instead of re-parsing prose.
 *
 * Handoffs are **run state, not content** — they live under `.sdlcof/runs/`, are
 * rebuildable, and are never a source of truth for anything in `kanban/`.
 */

/** Where a run's handoffs live, relative to the workspace root. */
export function handoffDir(stateDir: string, runId: string): string {
  return path.join(stateDir, 'runs', runId, 'handoffs');
}

/** Filename for one boundary. Ordered by stage pair, so a directory listing reads chronologically. */
function handoffFile(handoff: Pick<StageHandoff, 'from' | 'to'>): string {
  return `${handoff.from}--${handoff.to}.json`;
}

/**
 * The reason a handoff was rejected, or `null` when it was accepted.
 *
 * A rejected handoff is not an exception: a subagent returning the wrong shape
 * is an expected outcome the orchestrator has to handle (re-ask, escalate), and
 * a thrown error at a stage boundary would take the whole run with it.
 */
export interface HandoffRejection {
  readonly reason: 'invalid-shape' | 'structural';
  readonly detail: string;
}

export type HandoffResult =
  | { readonly ok: true; readonly handoff: StageHandoff }
  | { readonly ok: false; readonly rejection: HandoffRejection };

/**
 * Validates a candidate handoff, optionally against the previous boundary.
 *
 * The `previous` argument is what makes the "open questions are carried forward"
 * property real rather than aspirational — see
 * {@link handoffProblems}. Callers that skip it get shape validation only, which
 * is exactly the weaker guarantee ADR-0021 was written about.
 */
export function acceptHandoff(candidate: unknown, previous?: StageHandoff): HandoffResult {
  const parsed = StageHandoffSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      rejection: {
        reason: 'invalid-shape',
        detail: parsed.error.issues
          .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
          .join('; '),
      },
    };
  }

  const problems = handoffProblems(parsed.data, previous);
  if (problems.length > 0) {
    return {
      ok: false,
      rejection: {
        reason: 'structural',
        detail: problems.map((problem) => `${problem.field}: ${problem.detail}`).join('; '),
      },
    };
  }

  return { ok: true, handoff: parsed.data };
}

/**
 * Persists an accepted handoff under the run's state directory.
 *
 * Validation happens here too, not only at the call site. A file on disk is what
 * the next stage reads, and something that reached disk unvalidated would be
 * trusted by everything downstream.
 */
export async function writeHandoff(stateDir: string, handoff: StageHandoff): Promise<string> {
  const accepted = acceptHandoff(handoff);
  if (!accepted.ok) {
    throw new Error(`refusing to write an invalid handoff — ${accepted.rejection.detail}`);
  }
  const dir = handoffDir(stateDir, handoff.runId);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, handoffFile(handoff));
  await fs.writeFile(file, `${JSON.stringify(accepted.handoff, null, 2)}\n`, 'utf8');
  return file;
}

/**
 * Reads the handoff produced at a given boundary, or `null` when there is none.
 *
 * Absent and unreadable are deliberately different: a missing handoff means the
 * boundary has not been crossed yet, while corrupt JSON means something wrote
 * garbage — and silently treating the second as the first would let a stage
 * proceed as though nothing had come before it.
 */
export async function readHandoff(
  stateDir: string,
  runId: string,
  from: LifecycleStage,
  to: LifecycleStage,
): Promise<StageHandoff | null> {
  const file = path.join(handoffDir(stateDir, runId), handoffFile({ from, to }));
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
  const parsed = StageHandoffSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(`handoff at ${file} is not a valid stage handoff: ${parsed.error.message}`);
  }
  return parsed.data;
}

/**
 * Every handoff recorded for a run, in the order the stages were crossed.
 *
 * Follows the `from`/`to` links rather than sorting filenames: alphabetical
 * order would put `approval--done` before `implement--test`, which is the
 * opposite of when they happened.
 */
export async function readHandoffChain(
  stateDir: string,
  runId: string,
): Promise<readonly StageHandoff[]> {
  const dir = handoffDir(stateDir, runId);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }

  const handoffs: StageHandoff[] = [];
  for (const name of names.filter((entry) => entry.endsWith('.json'))) {
    const raw = await fs.readFile(path.join(dir, name), 'utf8');
    const parsed = StageHandoffSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      throw new Error(`handoff at ${path.join(dir, name)} is not valid: ${parsed.error.message}`);
    }
    handoffs.push(parsed.data);
  }

  const byFrom = new Map(handoffs.map((handoff) => [handoff.from, handoff]));
  const isSuccessor = new Set(handoffs.map((handoff) => handoff.to));
  const head = handoffs.find((handoff) => !isSuccessor.has(handoff.from));
  if (head === undefined) return handoffs;

  const chain: StageHandoff[] = [];
  const seen = new Set<LifecycleStage>();
  let current: StageHandoff | undefined = head;
  while (current !== undefined && !seen.has(current.from)) {
    seen.add(current.from);
    chain.push(current);
    current = byFrom.get(current.to);
  }
  // Anything not reachable from the head is still reported. A handoff we cannot
  // place in the chain is a bug worth seeing, not one worth hiding.
  for (const handoff of handoffs) {
    if (!chain.includes(handoff)) chain.push(handoff);
  }
  return chain;
}
