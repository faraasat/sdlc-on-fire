import { createHash } from 'node:crypto';
import os from 'node:os';
import { EvidenceEnvelopeSchema, resolveWorkspaceLayout } from '@sdlc-on-fire/core';
import { applySchema, PostgresStorageAdapter } from '@sdlc-on-fire/db';
import { createGitManager } from '@sdlc-on-fire/daemon';
import { persistEvidence } from '@sdlc-on-fire/evidence';
import { parseFrontmatter } from '@sdlc-on-fire/storage';
import fs from 'node:fs/promises';
import path from 'node:path';
import { findWorkItem, openWorkspaceDatabase } from './commands.js';
import { currentDirtyTreeHash } from './verify.js';

/**
 * `sdlc review` — recording that a review actually happened
 * (P1-GATE-03 hardening, from the v007 evaluation).
 *
 * The `review-before-done` guard used to check that a *transition into review*
 * had been recorded — which a blind evaluator satisfied by running `sdlc advance`
 * and doing nothing else. Passing through a stage is not the same as being
 * reviewed, and a guard that cannot tell them apart guards nothing.
 *
 * Two properties make the record meaningful rather than ceremonial.
 *
 * **A reviewer is not the implementer.** The claim holder cannot review their own
 * item. This is the "no single agent both implements and self-certifies" rule
 * made mechanical instead of aspirational — and it is the check most likely to
 * catch a real problem, because self-review is what actually happens under time
 * pressure.
 *
 * **An agent's review is recorded and cannot gate.** Agents are actors, never
 * approvers (architecture §5), so an agent-authored review is stored with
 * `producer: 'agent-claim'` — visible to a human, structurally incapable of
 * satisfying the guard. It informs; it does not decide.
 *
 * Zero findings is allowed but must be *justified*, following the review skill's
 * own HALT-on-zero-findings rule: a reviewer who approves every diff is
 * indistinguishable from one who never ran.
 */

export interface ReviewResult {
  readonly workItemId: string;
  readonly reviewer: string;
  readonly actorKind: 'human' | 'agent';
  readonly findings: number;
  readonly gating: boolean;
  readonly evidenceId: number;
  readonly summary: string;
}

export class SelfReviewError extends Error {
  override readonly name = 'SelfReviewError';
  constructor(id: string, actor: string) {
    super(
      `"${actor}" holds the claim on ${id} and cannot review it. A reviewer who wrote the code ` +
        'is checking their own understanding, not the change — have someone else review it, or ' +
        'release the claim first.',
    );
  }
}

export async function recordReview(
  root: string,
  id: string,
  input: {
    readonly actor: string;
    readonly actorKind?: 'human' | 'agent' | undefined;
    readonly findings?: readonly string[] | undefined;
    readonly noFindingsBecause?: string | undefined;
  },
): Promise<ReviewResult> {
  const layout = resolveWorkspaceLayout(root);
  const found = await findWorkItem(layout.kanbanDir, id);
  if (found === null) throw new Error(`no work item with id "${id}" under ${layout.kanbanDir}`);

  const findings = (input.findings ?? []).filter((entry) => entry.trim() !== '');
  if (findings.length === 0 && (input.noFindingsBecause ?? '').trim() === '') {
    throw new Error(
      `a review of ${id} with no findings must say why — pass --no-findings-because "<reason>". ` +
        'A reviewer who approves every diff is indistinguishable from one who never ran.',
    );
  }

  const actorKind = input.actorKind ?? 'human';
  const git = createGitManager({ repoRoot: layout.root });
  const gitSha = (await git.isRepo()) ? await git.headSha() : '0'.repeat(40);
  const dirty = await currentDirtyTreeHash(layout.root);

  const { db } = await openWorkspaceDatabase(root);
  try {
    await applySchema(db);
    const port = await PostgresStorageAdapter.create(db);

    const data = parseFrontmatter(await fs.readFile(found.filePath, 'utf8')).data;
    await port.upsertWorkItem({
      id,
      type: typeof data['kind'] === 'string' ? data['kind'] : 'task',
      title: typeof data['title'] === 'string' ? data['title'] : id,
      status: typeof data['status'] === 'string' ? data['status'] : 'In Progress',
      lifecycleState: typeof data['lifecycle_state'] === 'string' ? data['lifecycle_state'] : '',
      filePath: path.relative(layout.root, found.filePath),
      contentHash: 'pending',
    });

    // `claimed_by` directly, not `claimOf` — the latter reports the *live*
    // lease, and a lapsed lease would let the implementer wait an hour and then
    // review their own work. Who last held the item is the fact that matters
    // here; whether their lease is still running is a different question.
    const holder = await db.query<{ claimed_by: string | null }>(
      'SELECT claimed_by FROM work_items WHERE id = $1;',
      [id],
    );
    if (holder[0]?.claimed_by === input.actor) {
      throw new SelfReviewError(id, input.actor);
    }

    const payload = {
      reviewer: input.actor,
      actor_kind: actorKind,
      findings,
      no_findings_because: input.noFindingsBecause ?? null,
      // `ok` means the review *happened and concluded*, not that it approved.
      // A review that found blockers is still a review; the findings are what a
      // human reads. Conflating "reviewed" with "approved" would make recording
      // problems look like failing to review.
      ok: true,
    };

    const envelope = EvidenceEnvelopeSchema.parse({
      // An agent's review is recorded as a **knowledge claim**, and that is the
      // schema being precise rather than a workaround. A DB trigger refuses
      // `agent-claim` evidence of any other kind (ADR-0030), and an agent saying
      // "I looked at this and it seems fine" *is* a knowledge claim. Recording
      // it as a `review` would make the product assert the very thing it exists
      // to disbelieve — and the guard then excludes agents by *kind*, which no
      // caller can talk its way around.
      kind: actorKind === 'agent' ? 'knowledge-claim' : 'review',
      producer: actorKind === 'agent' ? 'agent-claim' : 'human',
      git_sha: gitSha,
      ...(dirty === undefined ? {} : { dirty_tree_hash: dirty }),
      env: { tool_versions: { node: process.version }, os: `${os.platform()}-${os.arch()}` },
      content_hash: createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex'),
      confidence: actorKind === 'agent' ? 0.4 : 0.9,
      produced_at: new Date().toISOString(),
      payload,
    });

    const evidenceId = await persistEvidence(db, envelope);
    // An agent's review attaches to a `knowledge-claim` gate, not a `review`
    // one, and that is the schema telling the truth rather than a workaround: a
    // DB trigger refuses `agent-claim` evidence anywhere else (ADR-0030), and an
    // agent saying "I looked at this and it seems fine" *is* a knowledge claim.
    // Calling it a review at the gate level would be the product asserting
    // exactly the thing it exists to disbelieve.
    const gateName = actorKind === 'agent' ? 'knowledge-claim' : 'review';
    const gateRows = await db.query<{ id: number }>(
      `INSERT INTO gates (work_item_id, gate_name, result, evaluated_at)
       VALUES ($1, $3, $2, now()) RETURNING id;`,
      // `gates.result` is constrained to pending/pass/fail. A review that found
      // things is not a *failed* review — it is a review that did its job — so
      // the row records that the review completed and the findings themselves
      // live in the evidence payload where a human reads them.
      [id, 'pass', gateName],
    );
    const gateId = gateRows[0]?.id;
    if (gateId !== undefined) {
      await db.query(
        'INSERT INTO gate_evidence (gate_id, evidence_id) VALUES ($1,$2) ON CONFLICT DO NOTHING;',
        [gateId, evidenceId],
      );
    }

    return {
      workItemId: id,
      reviewer: input.actor,
      actorKind,
      findings: findings.length,
      gating: actorKind === 'human',
      evidenceId,
      summary:
        actorKind === 'agent'
          ? `recorded ${String(findings.length)} finding(s) — advisory only, an agent's review cannot satisfy the gate`
          : `recorded ${String(findings.length)} finding(s)`,
    };
  } finally {
    await db.close();
  }
}
