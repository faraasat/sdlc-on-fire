import fs from 'node:fs/promises';
import path from 'node:path';
import {
  ApprovalSchema,
  EchoBackSchema,
  checkEchoBack,
  renderHumanLoop,
  renderQna,
  resolveWorkspaceLayout,
  type EchoBack,
  type EchoBackApproval,
  type EchoBackVerdict,
} from '@sdlc-on-fire/core';
import { findWorkItem } from './commands.js';

/**
 * `sdlc echo` — recording the restated understanding and the human's answer
 * (P1-LIFE-05, ADR-0049).
 *
 * The exchange lives in `qna.md` and the decision in `human-loop.md`
 * (contracts/06) — files in git, not rows in the database. That is the
 * content/state split: what the human decided is content, and it has to survive
 * `db:rebuild` and be readable in a diff by whoever inherits the project.
 */

const ECHO_FILE = 'echo-back.json';
const APPROVAL_FILE = 'echo-approval.json';

/** Per-item intake record, under the workspace state dir — run state, rebuildable. */
function intakeDir(root: string, id: string): string {
  return path.join(resolveWorkspaceLayout(root).root, '.sdlcof', 'intake', id);
}

/** The initiative docs the exchange is appended to (contracts/06). */
function docsDir(root: string): string {
  return path.join(resolveWorkspaceLayout(root).root, 'docs', '.plan');
}

export async function recordEchoBack(root: string, echo: EchoBack): Promise<string> {
  const parsed = EchoBackSchema.parse(echo);
  const layout = resolveWorkspaceLayout(root);
  if ((await findWorkItem(layout.kanbanDir, parsed.workItemId)) === null) {
    throw new Error(`no work item with id "${parsed.workItemId}" under ${layout.kanbanDir}`);
  }

  const dir = intakeDir(root, parsed.workItemId);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, ECHO_FILE);
  await fs.writeFile(file, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');

  // Written before any approval exists, with every question marked unanswered.
  // A record that only appears once someone replies loses the case that matters
  // most: an echo-back nobody ever answered.
  await appendDoc(root, 'qna.md', renderQna(parsed));
  return file;
}

export async function readEchoBack(root: string, id: string): Promise<EchoBack | null> {
  try {
    return EchoBackSchema.parse(
      JSON.parse(await fs.readFile(path.join(intakeDir(root, id), ECHO_FILE), 'utf8')),
    );
  } catch {
    return null;
  }
}

export async function readEchoApproval(root: string, id: string): Promise<EchoBackApproval | null> {
  try {
    return ApprovalSchema.parse(
      JSON.parse(await fs.readFile(path.join(intakeDir(root, id), APPROVAL_FILE), 'utf8')),
    );
  } catch {
    return null;
  }
}

export interface ApproveResult {
  readonly workItemId: string;
  readonly verdict: EchoBackVerdict;
  readonly qnaPath: string;
  readonly humanLoopPath: string;
}

/**
 * How the caller established that a human is actually present.
 *
 * Not something the caller asserts about itself — `--as human` is a string an
 * agent can type as easily as a person can, and it did: walking the v0.1 DoD by
 * hand, `sdlc echo approve --as agent` succeeded and wrote **"decided by: agent
 * (human)"** into `human-loop.md`. The schema made an agent-kind approval
 * inexpressible; the CLI simply stamped `human` on whoever called it, so the one
 * gate that exists to break the agent-approves-its-own-understanding circularity
 * was satisfiable by the agent.
 *
 * An attached terminal is a property of the *process*, checked by the runtime —
 * the deterministic disposer ADR-0040 asks for, in place of a claim. A dispatched
 * agent runs with piped stdio and cannot produce one.
 */
export type HumanPresence =
  /** stdin and stdout are both TTYs and the person confirmed at the prompt. */
  | 'interactive-tty'
  /** No terminal: a script, a CI job, or an agent. Cannot approve. */
  | 'unattended';

/**
 * Records a human's decision on a restated understanding.
 *
 * The approval is validated against the echo-back it answers, not accepted on
 * its own: an approval naming fewer answers than there were questions approves
 * an understanding nobody completed, and it is refused before anything is
 * written.
 *
 * `presence` is computed by the command layer from the process it is running in,
 * never taken from an argument the caller supplies about itself.
 */
export async function approveEchoBack(
  root: string,
  id: string,
  input: {
    readonly actor: string;
    readonly presence: HumanPresence;
    readonly decision?: 'approved' | 'corrected' | undefined;
    readonly answers?: readonly string[] | undefined;
    readonly corrections?: readonly string[] | undefined;
  },
): Promise<ApproveResult> {
  if (input.presence !== 'interactive-tty') {
    throw new Error(
      `${id}: approving an echo-back needs a human at a terminal, and this process does not have one. ` +
        'This gate exists so an agent cannot approve its own understanding, and an agent runs exactly ' +
        'like this — no TTY. Run `sdlc echo approve` yourself from an interactive shell.',
    );
  }

  const echo = await readEchoBack(root, id);
  if (echo === null) {
    throw new Error(
      `${id} has no recorded echo-back to approve — the agent has to restate its understanding first`,
    );
  }

  const approval = ApprovalSchema.parse({
    actor: input.actor,
    // Humans only, structurally (architecture §5) — and now only reachable when
    // the process actually has a human attached, checked above.
    actorKind: 'human',
    decision: input.decision ?? 'approved',
    answers: [...(input.answers ?? [])],
    corrections: [...(input.corrections ?? [])],
    at: new Date().toISOString(),
  });

  const verdict = checkEchoBack(echo, approval);
  if (!verdict.ok) throw new Error(verdict.reason);

  await fs.writeFile(
    path.join(intakeDir(root, id), APPROVAL_FILE),
    `${JSON.stringify(approval, null, 2)}\n`,
    'utf8',
  );

  return {
    workItemId: id,
    verdict,
    // Re-appended with the answers filled in. The earlier unanswered copy stays:
    // the history of what was asked before it was answered is the audit trail.
    qnaPath: await appendDoc(root, 'qna.md', renderQna(echo, approval)),
    humanLoopPath: await appendDoc(root, 'human-loop.md', renderHumanLoop(echo, approval)),
  };
}

async function appendDoc(root: string, name: string, body: string): Promise<string> {
  const dir = docsDir(root);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, name);
  const existing = await fs.readFile(file, 'utf8').catch(() => `# ${name.replace('.md', '')}\n`);
  await fs.writeFile(file, `${existing.trimEnd()}\n\n${body}`, 'utf8');
  return file;
}
