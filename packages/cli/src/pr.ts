import {
  createGitManager,
  renderPrBody,
  renderPrTitle,
  type PrBodyInput,
} from '@sdlc-on-fire/daemon';
import { applySchema } from '@sdlc-on-fire/db';
import { defaultV01Policy, evaluateGate } from '@sdlc-on-fire/evidence';
import { resolveWorkspaceLayout, type EvidenceEnvelope } from '@sdlc-on-fire/core';
import { parseFrontmatter } from '@sdlc-on-fire/storage';
import { findWorkItem, openWorkspaceDatabase } from './commands.js';
import { currentDirtyTreeHash } from './verify.js';

/**
 * `sdlc pr` — the evidence bundle, assembled from what actually ran
 * (P1-GIT-02, FEAT-GIT-011).
 *
 * `renderPrBody` shipped in P1-SKILL-02 and had no caller anywhere in the
 * product. That is the same defect this build keeps finding in itself, and here
 * it was load-bearing: the whole argument for the PR bundle is that a reviewer
 * sees which commands ran and what they said instead of a sentence asserting
 * everything passed — and a renderer nothing calls produces no such body.
 *
 * This command reads the evidence out of the database rather than taking it from
 * a caller. An assembled-by-the-agent bundle would be a self-report with better
 * formatting, which is precisely what the product exists to refuse. What goes in
 * the body is what the daemon recorded, including runs that failed and runs that
 * have gone stale — a reviewer who sees only the flattering rows is worse
 * informed than one who sees none.
 */

export interface PrResult {
  readonly workItemId: string;
  readonly branch: string;
  readonly title: string;
  readonly body: string;
  /** Whether the gate would pass on this evidence right now. */
  readonly gatePasses: boolean;
  /** Evidence rows found for this item, including failing and stale ones. */
  readonly evidenceCount: number;
  readonly staleCount: number;
}

interface Row {
  readonly kind: string;
  readonly producer: string;
  readonly git_sha: string;
  readonly dirty_tree_hash: string | null;
  readonly env: unknown;
  readonly command: unknown;
  readonly content_hash: string;
  readonly confidence: string | number;
  readonly produced_at: Date | string;
  readonly payload: unknown;
}

export async function prFor(root: string, id: string): Promise<PrResult> {
  const layout = resolveWorkspaceLayout(root);
  const found = await findWorkItem(layout.kanbanDir, id);
  if (found === null) throw new Error(`no work item with id "${id}" under ${layout.kanbanDir}`);

  const parsed = parseFrontmatter(found.raw);
  const data = parsed.data;
  const title = typeof data['title'] === 'string' ? data['title'] : id;
  const kind = typeof data['kind'] === 'string' ? data['kind'] : 'task';

  const git = createGitManager({ repoRoot: layout.root });
  const isRepo = await git.isRepo();
  const headSha = isRepo ? await git.headSha() : '0'.repeat(40);
  const branch = isRepo ? await git.currentBranch() : '(not a git repository)';

  const { db } = await openWorkspaceDatabase(root);
  try {
    await applySchema(db);

    // Through `gates`, so the bundle is this item's evidence and nobody else's.
    const rows = await db.query<Row>(
      `SELECT e.kind, e.producer, e.git_sha, e.dirty_tree_hash, e.env, e.command,
              e.content_hash, e.confidence, e.produced_at, e.payload
         FROM evidence e
         JOIN gate_evidence ge ON ge.evidence_id = e.id
         JOIN gates g ON g.id = ge.gate_id
        WHERE g.work_item_id = $1
        ORDER BY e.produced_at DESC LIMIT 50;`,
      [id],
    );

    const evidence: EvidenceEnvelope[] = rows.map((row) => ({
      kind: row.kind as EvidenceEnvelope['kind'],
      producer: row.producer as EvidenceEnvelope['producer'],
      git_sha: row.git_sha,
      ...(row.dirty_tree_hash === null ? {} : { dirty_tree_hash: row.dirty_tree_hash }),
      env: row.env as EvidenceEnvelope['env'],
      ...(row.command === null ? {} : { command: row.command as EvidenceEnvelope['command'] }),
      content_hash: row.content_hash,
      confidence: Number(row.confidence),
      produced_at:
        row.produced_at instanceof Date ? row.produced_at.toISOString() : String(row.produced_at),
      payload: row.payload,
    }));

    const currentDirty = await currentDirtyTreeHash(layout.root);
    const verdict = evaluateGate(
      {
        ...defaultV01Policy(),
        evidence: [{ kind: 'test' as const, required: true, require_fresh: false }],
      },
      evidence,
      [],
      {
        currentHeadSha: headSha,
        ...(currentDirty === undefined ? {} : { currentDirtyTreeHash: currentDirty }),
        now: new Date(),
      },
    );

    const criteria = Array.isArray(data['acceptance_criteria'])
      ? (data['acceptance_criteria'] as unknown[]).filter(
          (entry): entry is string => typeof entry === 'string',
        )
      : undefined;

    const input: PrBodyInput = {
      workItemId: id,
      title,
      // The card body, not a generated summary. Asking a model to describe the
      // change would put an unverified sentence at the top of a document whose
      // entire purpose is that its claims are checkable.
      summary: parsed.body.trim(),
      ...(criteria === undefined || criteria.length === 0 ? {} : { acceptanceCriteria: criteria }),
      evidence,
      headSha,
      gateVerdict: { pass: verdict.pass, missing: verdict.missing, failures: verdict.failures },
    };

    return {
      workItemId: id,
      branch,
      title: renderPrTitle(id, title, kind === 'bug' ? 'fix' : 'feat'),
      body: renderPrBody(input),
      gatePasses: verdict.pass,
      evidenceCount: evidence.length,
      staleCount: evidence.filter((envelope) => envelope.git_sha !== headSha).length,
    };
  } finally {
    await db.close();
  }
}
