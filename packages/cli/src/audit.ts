import { createGitManager } from '@sdlc-on-fire/daemon';
import { applySchema } from '@sdlc-on-fire/db';
import {
  persistEvidence,
  runDependencyAudit,
  summariseAudit,
  type DependencyAudit,
} from '@sdlc-on-fire/evidence';
import { resolveWorkspaceLayout } from '@sdlc-on-fire/core';
import { openWorkspaceDatabase } from './commands.js';
import { currentDirtyTreeHash } from './verify.js';

/**
 * `sdlc audit` — dependency advisories as recorded, non-gating evidence
 * (P1-GATE-10).
 *
 * It records rather than blocks, and that is the decision. An advisory is a fact
 * about the ecosystem, not about the change under review: a task that touched
 * one CSS file does not become unfit to merge because a transitive dev
 * dependency got an advisory this morning. Gating on it would fail every work
 * item in the repo at once for a reason none of them caused, and a gate that
 * fires on everything stops being read.
 *
 * The exit code reflects *whether the audit ran*, not what it found. A non-zero
 * exit for findings would make this blocking through the back door, in CI if
 * nowhere else.
 */

export interface AuditResult {
  readonly command: string;
  readonly evidenceId: number;
  readonly summary: string;
  readonly audit: DependencyAudit;
}

export async function auditDependencies(
  root: string,
  options: { command?: string | undefined } = {},
): Promise<AuditResult> {
  const layout = resolveWorkspaceLayout(root);
  const git = createGitManager({ repoRoot: layout.root });
  const gitSha = (await git.isRepo()) ? await git.headSha() : '0'.repeat(40);
  const dirty = await currentDirtyTreeHash(layout.root);

  const [cmd, ...args] = (options.command ?? 'pnpm audit --json').split(' ');
  if (cmd === undefined) throw new Error('audit command is empty');

  const envelope = await runDependencyAudit(cmd, args, {
    cwd: layout.root,
    gitSha,
    ...(dirty === undefined ? {} : { dirtyTreeHash: dirty }),
  });

  const { db } = await openWorkspaceDatabase(root);
  try {
    await applySchema(db);
    // Recorded as evidence but deliberately *not* linked to a gate. The link is
    // what makes evidence gating; leaving it off is how "advisory only" is
    // expressed in the data rather than only in a comment.
    const evidenceId = await persistEvidence(db, envelope);
    const audit = envelope.payload as DependencyAudit;
    return {
      command: `${cmd} ${args.join(' ')}`.trim(),
      evidenceId,
      summary: summariseAudit(audit),
      audit,
    };
  } finally {
    await db.close();
  }
}
