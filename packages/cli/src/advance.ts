import fs from 'node:fs/promises';
import path from 'node:path';
import {
  isLifecycleStage,
  kanbanColumnForStage,
  nextStage,
  resolveRequiredStages,
  type Preset,
} from '@sdlc-on-fire/core';
import { parseFrontmatter, renderWorkItem } from '@sdlc-on-fire/storage';
import { defaultV01Policy, evaluateGate, persistEvidence } from '@sdlc-on-fire/evidence';
import { findWorkItem, openWorkspaceDatabase } from './commands.js';
import { currentDirtyTreeHash, runVerify } from './verify.js';
import { applySchema, PostgresStorageAdapter } from '@sdlc-on-fire/db';
import {
  createGitManager,
  LifecycleEngine,
  registerLifecycleInvariants,
} from '@sdlc-on-fire/daemon';

/**
 * `sdlc verify` and `sdlc advance` — the commands that make the gate real.
 *
 * A blind evaluation of the previous build found the product's entire thesis
 * unreachable: every card carried a `verify:` command, the gate could evaluate
 * evidence, the engine could refuse a transition — and no command ever ran the
 * command or attempted a transition. A user hand-edited `lifecycle_state: done`
 * with the test suite red and nothing objected.
 *
 * These two commands close that. `verify` runs the command and records what
 * happened; `advance` refuses to move an item without evidence that is real,
 * current, and produced by us rather than asserted by an agent.
 */

export interface VerifyCommandResult {
  readonly workItemId: string;
  readonly command: string;
  readonly ok: boolean;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly evidenceId: number;
  readonly summary: string;
  /**
   * How the result was read: a parsed test report, or only the exit code.
   *
   * Surfaced rather than kept internal because the difference is user-facing —
   * `exit-code-only` means we watched a command succeed, not that we watched a
   * suite pass, and a caller that cannot tell those apart will conflate them.
   */
  readonly report: 'parsed' | 'exit-code-only';
  readonly testsRun: number;
  readonly confidence: number;
}

/** Reads a card's `verify:` command, or explains why there isn't one. */
async function verifyCommandFor(
  root: string,
  id: string,
): Promise<{ command: string; filePath: string }> {
  const { resolveWorkspaceLayout } = await import('@sdlc-on-fire/core');
  const layout = resolveWorkspaceLayout(root);
  const found = await findWorkItem(layout.kanbanDir, id);
  if (found === null) throw new Error(`no work item with id "${id}" under ${layout.kanbanDir}`);

  const data = parseFrontmatter(found.raw).data;
  const command = typeof data['verify'] === 'string' ? data['verify'] : null;
  if (command === null || command.trim() === '') {
    throw new Error(
      `${id} declares no \`verify:\` command in its frontmatter, so there is nothing to run. ` +
        'Add one (e.g. `verify: pnpm test`) — a work item with no checkable definition of done ' +
        'cannot be gated, only asserted.',
    );
  }
  return { command, filePath: found.filePath };
}

export async function verifyWorkItem(root: string, id: string): Promise<VerifyCommandResult> {
  const { command, filePath } = await verifyCommandFor(root, id);
  const { resolveWorkspaceLayout } = await import('@sdlc-on-fire/core');
  const layout = resolveWorkspaceLayout(root);
  const card = parseFrontmatter(await fs.readFile(filePath, 'utf8')).data;
  const git = createGitManager({ repoRoot: root });
  const gitSha = (await git.isRepo()) ? await git.headSha() : '0'.repeat(40);

  const outcome = await runVerify({ command, cwd: root, gitSha });

  const { db } = await openWorkspaceDatabase(root);
  try {
    await applySchema(db);

    // The gate row references the work item, so the mirror has to know about the
    // card before evidence can be attached to it. Cards are files, and `verify`
    // is very often the first command run against a freshly written one.
    const port = await PostgresStorageAdapter.create(db);
    const declared = typeof card['lifecycle_state'] === 'string' ? card['lifecycle_state'] : '';
    const stage = isLifecycleStage(declared) ? declared : 'implement';
    await port.upsertWorkItem({
      id,
      type: typeof card['kind'] === 'string' ? card['kind'] : 'task',
      title: typeof card['title'] === 'string' ? card['title'] : id,
      status: kanbanColumnForStage(stage),
      lifecycleState: stage,
      workType: typeof card['work_type'] === 'string' ? card['work_type'] : 'feature',
      preset: typeof card['preset'] === 'string' ? card['preset'] : 'standard',
      filePath: path.relative(layout.root, filePath),
      contentHash: 'pending',
    });

    // Link the evidence to *this* work item through a gate row. Persisting the
    // envelope alone left it unattached, and every later query was therefore
    // workspace-global: one failing verify anywhere flipped the warning on for
    // every item, and one passing run anywhere cleared it — including for items
    // never re-verified. An adversarial evaluation found exactly that.
    const evidenceId = await persistEvidence(db, outcome.envelope);
    const gateRows = await db.query<{ id: number }>(
      `INSERT INTO gates (work_item_id, gate_name, result, evaluated_at)
       VALUES ($1, 'verify', $2, now()) RETURNING id;`,
      [id, outcome.ok ? 'pass' : 'fail'],
    );
    const gateId = gateRows[0]?.id;
    if (gateId !== undefined) {
      await db.query(
        'INSERT INTO gate_evidence (gate_id, evidence_id) VALUES ($1,$2) ON CONFLICT DO NOTHING;',
        [gateId, evidenceId],
      );
    }
    const payload = outcome.envelope.payload as {
      passed?: number;
      failed?: number;
      total?: number;
      report?: 'parsed' | 'exit-code-only';
    };
    const report = payload.report ?? 'exit-code-only';
    const total = payload.total ?? 0;
    return {
      workItemId: id,
      command,
      ok: outcome.ok,
      exitCode: outcome.exitCode,
      durationMs: outcome.durationMs,
      evidenceId,
      report,
      testsRun: total,
      confidence: outcome.envelope.confidence,
      summary: outcome.ok
        ? report === 'parsed'
          ? `passed (${String(payload.passed ?? total)}/${String(total)} tests)`
          : 'exited 0 — no test report was parsed, so no test count was observed'
        : `FAILED (exit ${String(outcome.exitCode)})`,
    };
  } finally {
    await db.close();
  }
}

export interface AdvanceResult {
  readonly workItemId: string;
  readonly from: string;
  readonly to: string | null;
  readonly moved: boolean;
  /** Why it was refused. Empty when it moved. */
  readonly refusals: readonly string[];
}

/**
 * Attempts one lifecycle step, through the guards and the gate.
 *
 * On success the **file** is rewritten, not the database row: content is the
 * source of truth and the mirror follows (architecture §5). Writing the mirror
 * and leaving the card behind would make the two disagree, and the card would
 * win on the next sync.
 */
export async function advanceWorkItem(root: string, id: string): Promise<AdvanceResult> {
  const { resolveWorkspaceLayout } = await import('@sdlc-on-fire/core');
  const layout = resolveWorkspaceLayout(root);
  const found = await findWorkItem(layout.kanbanDir, id);
  if (found === null) throw new Error(`no work item with id "${id}" under ${layout.kanbanDir}`);

  const parsed = parseFrontmatter(found.raw);
  const data = parsed.data;
  const from = typeof data['lifecycle_state'] === 'string' ? data['lifecycle_state'] : '';
  const preset = (typeof data['preset'] === 'string' ? data['preset'] : 'standard') as Preset;
  const workType = typeof data['work_type'] === 'string' ? data['work_type'] : 'feature';

  if (!isLifecycleStage(from)) {
    return {
      workItemId: id,
      from,
      to: null,
      moved: false,
      refusals: [`"${from}" is not a lifecycle stage`],
    };
  }
  const to = nextStage(preset, workType, from);
  if (to === null) {
    const ladder = resolveRequiredStages(preset, workType)?.join(' → ') ?? '(none)';
    return {
      workItemId: id,
      from,
      to: null,
      moved: false,
      refusals: [`${id} is at "${from}" — nothing comes next on ${preset}/${workType} (${ladder})`],
    };
  }

  const { db } = await openWorkspaceDatabase(root);
  try {
    await applySchema(db);
    const port = await PostgresStorageAdapter.create(db);
    const engine = new LifecycleEngine(db);
    registerLifecycleInvariants(engine);

    // The mirror must know about this item before the engine can reason about
    // it — a card created and never synced would look like an unknown id.
    await port.upsertWorkItem({
      id,
      type: typeof data['kind'] === 'string' ? data['kind'] : 'task',
      title: typeof data['title'] === 'string' ? data['title'] : id,
      status: kanbanColumnForStage(from),
      lifecycleState: from,
      workType,
      preset,
      filePath: path.relative(layout.root, found.filePath),
      contentHash: 'pending',
    });

    const refusals: string[] = [];

    // 1. Structural + invariant guards.
    const decision = await engine.canTransition(id, to);
    if (!decision.allowed) refusals.push(`${decision.guard}: ${decision.reason}`);

    // 2. The evidence gate.
    //
    // A stage that exists to prove something cannot be entered on a card that
    // declares nothing to prove. Previously this skipped the gate when `verify:`
    // was absent, which fails **open**: the fastest way past the gate became
    // deleting the field it reads. Refusing is the only safe default — the
    // remedy is one line of frontmatter, and it is named in the refusal.
    const EVIDENCE_STAGES = new Set(['test', 'done']);
    const verifyCommand = typeof data['verify'] === 'string' ? data['verify'] : null;
    const declaresCheck = verifyCommand !== null && verifyCommand.trim() !== '';

    if (!declaresCheck && EVIDENCE_STAGES.has(to)) {
      refusals.push(
        `gate: ${id} declares no \`verify:\` command, so entering "${to}" cannot be evidenced. ` +
          'Add one to the card (e.g. `verify: pnpm test`) — a stage that exists to prove something ' +
          'cannot be entered on a claim.',
      );
    }

    if (declaresCheck) {
      const git = createGitManager({ repoRoot: layout.root });
      const headSha = (await git.isRepo()) ? await git.headSha() : '0'.repeat(40);

      // Scoped to this work item through gates → gate_evidence. Querying
      // `evidence` globally let another item's passing run satisfy this item's
      // gate: an adversarial evaluation walked a card to `done` on a green run
      // that belonged to a different card entirely.
      const rows = await db.query<{
        payload: unknown;
        git_sha: string;
        dirty_tree_hash: string | null;
        producer: string;
        kind: string;
        content_hash: string;
        confidence: string | number;
        produced_at: Date | string;
        env: unknown;
      }>(
        `SELECT e.kind, e.producer, e.git_sha, e.dirty_tree_hash, e.env, e.content_hash,
                e.confidence, e.produced_at, e.payload
           FROM evidence e
           JOIN gate_evidence ge ON ge.evidence_id = e.id
           JOIN gates g ON g.id = ge.gate_id
          WHERE g.work_item_id = $1 AND e.kind = 'test'
          ORDER BY e.produced_at DESC LIMIT 20;`,
        [id],
      );
      const bundle = rows.map((row) => ({
        kind: row.kind as 'test',
        producer: row.producer as 'daemon',
        git_sha: row.git_sha,
        // Carried so the staleness check can see an uncommitted change. Dropping
        // it made evidence produced on a dirty tree look current forever.
        ...(row.dirty_tree_hash === null ? {} : { dirty_tree_hash: row.dirty_tree_hash }),
        env: row.env as { tool_versions: Record<string, string>; os: string },
        content_hash: row.content_hash,
        confidence: Number(row.confidence),
        produced_at:
          row.produced_at instanceof Date ? row.produced_at.toISOString() : String(row.produced_at),
        payload: row.payload,
      }));

      // The policy must ask only for what this card can actually produce. The
      // default v0.1 policy demands test + typecheck + build; a card declaring a
      // single `verify:` command can never satisfy three kinds, and a gate that
      // cannot be satisfied is not a gate, it is a wall. One declared command,
      // one required kind.
      const policy = {
        ...defaultV01Policy(preset),
        evidence: [{ kind: 'test' as const, required: true, require_fresh: false }],
      };
      const currentDirty = await currentDirtyTreeHash(layout.root);
      const verdict = evaluateGate(policy, bundle, [], {
        currentHeadSha: headSha,
        ...(currentDirty === undefined ? {} : { currentDirtyTreeHash: currentDirty }),
        now: new Date(),
      });
      if (!verdict.pass) {
        for (const kind of verdict.missing) {
          // "You never ran it" and "you ran it, then changed the code" need
          // different remediations, and the message must say which. Reporting
          // both as "no evidence — run verify" told a blind evaluator to run the
          // command they had just run; they retried six times and concluded the
          // gate was broken. It was not — it was inarticulate.
          const priorRuns = bundle.filter((envelope) => envelope.kind === kind);
          refusals.push(
            priorRuns.length === 0
              ? `gate: no ${kind} evidence for ${id} — run \`sdlc verify ${id}\` (an agent saying it passed does not count)`
              : `gate: ${id} has ${String(priorRuns.length)} recorded ${kind} run(s), but none describes the current tree ` +
                  `(latest: ${priorRuns[0]?.produced_at ?? 'unknown'}). The code changed after the check — ` +
                  `re-run \`sdlc verify ${id}\`.`,
          );
        }
        for (const kind of verdict.failures) {
          refusals.push(
            `gate: ${kind} evidence says the check did not pass — fix the code, then re-verify`,
          );
        }
      }
    }

    if (refusals.length > 0) {
      return { workItemId: id, from, to, moved: false, refusals };
    }

    // Record the transition. Without this the history the guards read is always
    // empty, so `spec-before-implement` and `review-before-done` can never be
    // satisfied — a work item could never legitimately reach implement at all,
    // and hand-editing the card became the only way to make progress. A guard
    // that reads a history nothing writes is a guard that blocks forever.
    await db.query(
      `INSERT INTO lifecycle_transitions (work_item_id, from_state, to_state, gate_result)
       VALUES ($1,$2,$3,$4::jsonb);`,
      [id, from, to, JSON.stringify({ pass: true, missing: [], failures: [] })],
    );

    // Content is the source of truth: rewrite the card, let sync follow.
    const advanced = {
      ...data,
      lifecycle_state: to,
      status: kanbanColumnForStage(to),
      updated_at: new Date().toISOString(),
    };
    await fs.writeFile(
      found.filePath,
      renderWorkItem(advanced as never, parsed.body.trim() + '\n'),
      'utf8',
    );

    return { workItemId: id, from, to, moved: true, refusals: [] };
  } finally {
    await db.close();
  }
}
