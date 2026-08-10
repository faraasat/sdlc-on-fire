import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EvidenceEnvelopeSchema, resolveWorkspaceLayout } from '@sdlc-on-fire/core';
import { chunkMarkdown } from '@sdlc-on-fire/context';
import { applySchema, PostgresStorageAdapter } from '@sdlc-on-fire/db';
import { createGitManager } from '@sdlc-on-fire/daemon';
import {
  edgesFromClaims,
  persistEvidence,
  recordEdges,
  verifyClaims,
  type CitedChunk,
  type ClaimBundle,
  type KnowledgeClaim,
} from '@sdlc-on-fire/evidence';
import { parseFrontmatter } from '@sdlc-on-fire/storage';
import { findWorkItem, openWorkspaceDatabase } from './commands.js';
import { currentDirtyTreeHash } from './verify.js';

/**
 * `sdlc claims` — verifying what an agent asserted (P1-GATE-04, ADR-0019).
 *
 * The gate that runs test commands exists because "tests pass" is a claim. "AC-3
 * is satisfied" is the same kind of claim and had nothing checking it at all.
 *
 * The verification runs **here**, in the daemon, over the chunks the agent
 * cited — never over a fresh retrieval. Re-retrieving would answer a different
 * question: whether support exists somewhere, rather than whether the agent had
 * it. An agent that cites a real chunk it never read is still fabricating.
 *
 * The result is a `knowledge-claim` envelope with `producer: 'daemon'`, so it
 * can gate. The agent's own claims stay `agent-claim` and cannot.
 */

/**
 * The chunk space a claim may cite.
 *
 * Deliberately the work item's own card plus the documents it links: a citable
 * space has to be one both sides can name without a retrieval index, and
 * `<path>#<index>` is the id shape the retriever already emits.
 */
export async function citableChunks(root: string, cardPath: string): Promise<CitedChunk[]> {
  const layout = resolveWorkspaceLayout(root);
  const chunks: CitedChunk[] = [];

  const sources = new Set<string>([cardPath]);
  const card = await fs.readFile(cardPath, 'utf8');
  for (const match of card.matchAll(/\]\(([^)]+\.md)\)/g)) {
    const target = match[1];
    if (target === undefined || target.startsWith('http')) continue;
    const resolved = path.resolve(path.dirname(cardPath), target);
    // A card is authored content and its links are data. One that points out of
    // the workspace does not get followed.
    if (resolved.startsWith(path.resolve(layout.root) + path.sep)) sources.add(resolved);
  }

  for (const source of [...sources].sort()) {
    const text = await fs.readFile(source, 'utf8').catch(() => null);
    if (text === null) continue;
    const relative = path.relative(layout.root, source);
    for (const chunk of chunkMarkdown(text)) {
      chunks.push({ id: `${relative}#${String(chunk.index)}`, text: chunk.text });
    }
  }
  return chunks;
}

export interface ClaimsResult {
  readonly workItemId: string;
  readonly bundle: ClaimBundle;
  readonly evidenceId: number;
  readonly chunksAvailable: number;
  readonly gateResult: 'pass' | 'fail';
}

/**
 * Verifies an agent's claims about a work item and records the outcome.
 *
 * No entailment judge is passed. v0.1 has none configured, and the gate says so
 * through abstention rather than by passing what it could not check — see
 * `verifyClaims`. Wiring a judge is a later change to this one call site.
 */
export async function verifyWorkItemClaims(
  root: string,
  id: string,
  claims: readonly KnowledgeClaim[],
): Promise<ClaimsResult> {
  const layout = resolveWorkspaceLayout(root);
  const found = await findWorkItem(layout.kanbanDir, id);
  if (found === null) throw new Error(`no work item with id "${id}" under ${layout.kanbanDir}`);

  const pack = await citableChunks(layout.root, found.filePath);
  const bundle = await verifyClaims(claims, pack);

  const git = createGitManager({ repoRoot: layout.root });
  const gitSha = (await git.isRepo()) ? await git.headSha() : '0'.repeat(40);
  const dirty = await currentDirtyTreeHash(layout.root);

  const payload = {
    ok: bundle.ok,
    results: bundle.results,
    unsupported: bundle.unsupported,
    abstained: bundle.abstained,
    judge_calls: bundle.judgeCalls,
    // Recorded so a later reader knows *why* everything abstained, rather than
    // inferring that the claims were bad.
    judge: 'none-configured',
  };

  const { db } = await openWorkspaceDatabase(root);
  try {
    await applySchema(db);

    // The card is the source of truth and the DB is a mirror (architecture §5),
    // so an item that has never been synced has no row for a gate to reference.
    // Mirroring here rather than requiring a prior `sdlc sync` keeps the gate
    // usable on a fresh workspace.
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

    const envelope = EvidenceEnvelopeSchema.parse({
      kind: 'knowledge-claim',
      // The daemon verified. This is what lets the result gate at all — the
      // agent's own version of the same claims is `agent-claim` and cannot.
      producer: 'daemon',
      git_sha: gitSha,
      ...(dirty === undefined ? {} : { dirty_tree_hash: dirty }),
      env: { tool_versions: { node: process.version }, os: `${os.platform()}-${os.arch()}` },
      content_hash: createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex'),
      confidence: bundle.ok ? 0.9 : 0.5,
      produced_at: new Date().toISOString(),
      payload,
    });

    const evidenceId = await persistEvidence(db, envelope);
    // `gates.result` allows pending/pass/fail only. Abstention is not a third
    // value there, so it records as `fail` and the *payload* carries the
    // distinction a human needs — which is where the two routes live anyway.
    const gateResult = bundle.ok ? 'pass' : 'fail';
    const gateRows = await db.query<{ id: number }>(
      `INSERT INTO gates (work_item_id, gate_name, result, evaluated_at)
       VALUES ($1,'knowledge-claim',$2, now()) RETURNING id;`,
      [id, gateResult],
    );
    const gateId = gateRows[0]?.id;
    if (gateId !== undefined) {
      await db.query(
        'INSERT INTO gate_evidence (gate_id, evidence_id) VALUES ($1,$2) ON CONFLICT DO NOTHING;',
        [gateId, evidenceId],
      );
    }

    // A verified claim is exactly the requirement→artifact link ADR-0032 wants
    // retained: the claim is the requirement end, the chunk it cited is the
    // file end, and this run is the proof. Only *supported* claims become edges.
    await recordEdges(
      db,
      edgesFromClaims({
        workItemId: id,
        evidenceId,
        commitSha: gitSha,
        results: bundle.results.map((result) => ({
          claim: result.claim,
          citedChunkId: result.citedChunkId,
          verdict: result.verdict,
        })),
      }),
    );

    return { workItemId: id, bundle, evidenceId, chunksAvailable: pack.length, gateResult };
  } finally {
    await db.close();
  }
}

/** Human-readable report. The two failing routes are labelled, never merged. */
export function formatClaims(result: ClaimsResult): string {
  const lines: string[] = [
    `Knowledge claims for ${result.workItemId} — ${String(result.bundle.results.length)} sub-claim(s) over ${String(result.chunksAvailable)} citable chunk(s)`,
    '',
  ];
  for (const entry of result.bundle.results) {
    const mark = entry.verdict === 'supported' ? '✅' : entry.verdict === 'abstain' ? '⚠️ ' : '❌';
    lines.push(`${mark} ${entry.verdict.toUpperCase()} [${entry.method}] ${entry.claim}`);
    lines.push(`   ${entry.detail}`);
  }
  lines.push('');
  if (result.bundle.unsupported.length > 0) {
    lines.push(
      `❌ ${String(result.bundle.unsupported.length)} claim(s) cite what does not support them — flag for review.`,
    );
  }
  if (result.bundle.abstained.length > 0) {
    lines.push(
      `⚠️  ${String(result.bundle.abstained.length)} claim(s) could not be verified — give the stage more context and re-run.`,
    );
  }
  if (result.bundle.ok) lines.push('✅ Every claim is grounded in what it cites.');
  return lines.join('\n');
}
