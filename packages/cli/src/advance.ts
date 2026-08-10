import fs from 'node:fs/promises';
import path from 'node:path';
import {
  checkEchoBack,
  isLifecycleStage,
  isTerminalStage,
  kanbanColumnForStage,
  nextStage,
  resolveRequiredStages,
  type Preset,
} from '@sdlc-on-fire/core';
import { parseFrontmatter, renderWorkItem } from '@sdlc-on-fire/storage';
import {
  defaultV01Policy,
  edgesFromGateRun,
  evaluateGate,
  evaluateReadiness,
  isAdmissibleOverride,
  persistEvidence,
  recordEdges,
} from '@sdlc-on-fire/evidence';
import { findWorkItem, openWorkspaceDatabase, readConfig, treeContext } from './commands.js';
import { readEchoApproval, readEchoBack } from './echo.js';
import { attestItem } from './attest.js';
import { versionOf, writeCardIfUnchanged } from './lifecycle-write.js';
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
  /** Confinement actually applied — reported so it cannot be assumed. */
  readonly sandbox: string;
  readonly sandboxReason: string;
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

/**
 * Refuses when someone else holds the claim.
 *
 * The claim was enforced only between competing `claim` calls: two actors could
 * not both take an item, and then every command that actually *did* something to
 * it ignored who held it. A lease nothing consults is a lease that prevents
 * nothing — a blind evaluation walked items through their whole lifecycle
 * without ever holding the claim, and the one guard that mentions claims only
 * asked whether *a* claim existed, never whose.
 *
 * An unclaimed item is not refused. Claiming is how you announce work is yours,
 * and requiring it to run a check would make looking at something cost more than
 * taking it.
 */
async function assertClaimOwnership(
  port: { claimOf(id: string): Promise<{ claimedBy: string } | null> },
  id: string,
  actor: string | undefined,
): Promise<string | null> {
  const held = await port.claimOf(id);
  if (held === null) return null;
  if (actor !== undefined && held.claimedBy === actor) return null;
  // Naming what actually works. This used to end "take it over deliberately with
  // `sdlc claim`" — run exactly that and it refuses with "already held by", because
  // no takeover exists: contention hardening rides with team mode (ADR-0048 §v0.1).
  // An error that prescribes a command which cannot work is worse than one that
  // only states the problem.
  return (
    `${id} is claimed by "${held.claimedBy}"` +
    (actor === undefined ? ' — pass `--as <actor>` to say who you are' : `, not by "${actor}"`) +
    `. Either run it as the holder (\`--as ${held.claimedBy}\`) or wait for the lease to lapse; ` +
    'there is no takeover in v0.1.'
  );
}

export async function verifyWorkItem(
  root: string,
  id: string,
  options: { actor?: string | undefined } = {},
): Promise<VerifyCommandResult> {
  const { command, filePath } = await verifyCommandFor(root, id);
  const { resolveWorkspaceLayout } = await import('@sdlc-on-fire/core');
  const layout = resolveWorkspaceLayout(root);
  const card = parseFrontmatter(await fs.readFile(filePath, 'utf8')).data;
  const git = createGitManager({ repoRoot: root });
  const gitSha = (await git.isRepo()) ? await git.headSha() : '0'.repeat(40);

  // The workspace's own sandbox setting, read here rather than defaulted at the
  // call site — a security control that only applies when a caller remembers to
  // pass it is one that will eventually not apply.
  const config = await readConfig(root);
  const outcome = await runVerify({
    command,
    cwd: root,
    gitSha,
    ...(config?.sandbox === undefined ? {} : { sandbox: config.sandbox }),
  });

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

    // Recording evidence against an item is a write to someone else's work.
    // Running the check is free; attributing the result is not.
    const ownership = await assertClaimOwnership(port, id, options.actor);
    if (ownership !== null) throw new Error(ownership);

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
    // The traceability graph (P1-GATE-08, ADR-0032). Off the critical path and
    // never able to fail this call: the verdict above is already decided, and a
    // graph that can break a passing verify has stopped being an audit artifact
    // and become a dependency. What it retains is what the run already proved.
    await recordEdges(
      db,
      edgesFromGateRun({
        workItemId: id,
        commitSha: gitSha,
        evidenceId,
        acceptanceCriteria: Array.isArray(card['done'])
          ? card['done'].filter((entry): entry is string => typeof entry === 'string')
          : [],
      }),
    );

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
      sandbox: outcome.sandbox.tier,
      sandboxReason: outcome.sandbox.reason,
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

/** Frontmatter list fields arrive as unknown; a non-list is an absent list, not a crash. */
function asStringArray(value: unknown): string[] {
  if (Array.isArray(value))
    return value.filter((entry): entry is string => typeof entry === 'string');
  if (typeof value === 'string' && value.trim() !== '') {
    return value
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
  }
  return [];
}

/**
 * Which of the given ids have actually finished.
 *
 * Read from the mirror rather than trusted from the card: "blocked by TASK-9"
 * is the author's statement, and whether TASK-9 is done is a fact.
 */
async function finishedAmong(
  db: { query: <T>(sql: string, params?: unknown[]) => Promise<T[]> },
  ids: readonly string[],
): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await db.query<{ id: string }>(
    "SELECT id FROM work_items WHERE id = ANY($1) AND lifecycle_state = 'done';",
    [[...ids]],
  );
  return rows.map((row) => row.id);
}

export interface AdvanceResult {
  readonly workItemId: string;
  readonly from: string;
  readonly to: string | null;
  readonly moved: boolean;
  /** Why it was refused. Empty when it moved. */
  readonly refusals: readonly string[];
  /**
   * Definition-of-Ready findings (P1-GATE-07, ADR-0031).
   *
   * Reported alongside a *successful* move under lite/standard, because that is
   * what a soft gate is: the work proceeds and the reader is told what was
   * under-specified. Under `strict` they arrive in `refusals` instead.
   */
  readonly readiness?: readonly string[] | undefined;
}

/**
 * Attempts one lifecycle step, through the guards and the gate.
 *
 * On success the **file** is rewritten, not the database row: content is the
 * source of truth and the mirror follows (architecture §5). Writing the mirror
 * and leaving the card behind would make the two disagree, and the card would
 * win on the next sync.
 */
export async function advanceWorkItem(
  root: string,
  id: string,
  options: { actor?: string | undefined; readinessOverride?: string | undefined } = {},
): Promise<AdvanceResult> {
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

    // 0. Whose work is this? Checked before the guards, because "you do not hold
    // this item" is a more useful thing to be told than a gate verdict about an
    // item that is not yours.
    const ownership = await assertClaimOwnership(port, id, options.actor);
    if (ownership !== null) refusals.push(`claim: ${ownership}`);

    // 1. Structural + invariant guards.
    const decision = await engine.canTransition(id, to);
    if (!decision.allowed) refusals.push(`${decision.guard}: ${decision.reason}`);

    // 1a. The echo-back gate (ADR-0049). Evaluated on the way *out* of intake
    // and discovery: the point is to catch a misread requirement before anyone
    // spends a planning stage on it, and after planning the misreading has
    // already been paid for.
    //
    // The human approval is the deterministic disposer here — the agent's own
    // confidence in its understanding authorizes nothing.
    if (from === 'intake' || from === 'discovery') {
      const echo = await readEchoBack(layout.root, id);
      if (echo === null) {
        refusals.push(
          `echo-back: ${id} has not restated what it understood. Building the wrong thing is the ` +
            'most common way this goes wrong, and it is cheapest to catch here — record the ' +
            'restatement, then `sdlc echo approve`.',
        );
      } else {
        const echoConfig = await readConfig(layout.root);
        const verdict = checkEchoBack(
          echo,
          (await readEchoApproval(layout.root, id)) ?? undefined,
          {
            autoApproveUnambiguous: echoConfig?.intake?.autoApproveUnambiguous ?? false,
          },
        );
        if (!verdict.ok) refusals.push(`echo-back: ${verdict.reason}`);
      }
    }

    // 1b. Definition of Ready (ADR-0031) — entry criteria, evaluated on the way
    // *into* planning and implementation. Checking readiness at `done` would be
    // asking whether work that is finished was well-specified, which is a
    // retrospective, not a gate.
    const READINESS_STAGES = new Set(['plan', 'implement']);
    let readiness: readonly string[] | undefined;
    if (READINESS_STAGES.has(to)) {
      // The workspace can enforce entry criteria without choosing the strict
      // preset (ADR-0067). Reading the flag is what keeps it from being a switch
      // that reports `enabled: true` and changes nothing.
      const dorConfig = await readConfig(layout.root);
      const verdict = evaluateReadiness({
        id,
        preset,
        enforce: dorConfig?.advanced?.definition_of_ready_gate === true,
        acceptanceCriteria: asStringArray(data['done']),
        nonGoals: asStringArray(data['non_goals']),
        blockedBy: asStringArray(data['blocked_by']),
        resolvedBlockers: await finishedAmong(db, asStringArray(data['blocked_by'])),
      });

      if (!verdict.ready) {
        readiness = verdict.findings.map((finding) => `${finding.check}: ${finding.detail}`);
        const override = options.readinessOverride;
        const admissible =
          override !== undefined &&
          isAdmissibleOverride({
            workItemId: id,
            actor: options.actor ?? 'local',
            reason: override,
            findings: verdict.findings.map((finding) => finding.check),
          });

        if (verdict.blocked && !admissible) {
          // Only reachable under `strict`, where the workspace asked for it.
          refusals.push(
            ...verdict.findings.map((finding) => `ready: ${finding.detail} — ${finding.remedy}`),
          );
          if (override !== undefined) {
            refusals.push(
              'ready: the override needs a reason, not a gesture — one sentence saying why ' +
                'starting under-specified work is the right call here',
            );
          }
        }
      }
    }

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
        command: unknown;
        producer: string;
        kind: string;
        content_hash: string;
        confidence: string | number;
        produced_at: Date | string;
        env: unknown;
      }>(
        `SELECT e.kind, e.producer, e.git_sha, e.dirty_tree_hash, e.env, e.command, e.content_hash,
                e.confidence, e.produced_at, e.payload
           FROM evidence e
           JOIN gate_evidence ge ON ge.evidence_id = e.id
           JOIN gates g ON g.id = ge.gate_id
          WHERE g.work_item_id = $1 AND e.kind = 'test'
          ORDER BY e.produced_at DESC LIMIT 20;`,
        [id],
      );
      // Evidence produced by a *different* check is not evidence about this
      // one. Without this, editing one line of YAML — `verify: pnpm test` to
      // `verify: "true"` — walked an item to `done` with the real suite failing
      // untouched, and every downstream check was satisfied because from its
      // point of view the check genuinely passed.
      const matchesDeclaredCommand = (command: unknown): boolean => {
        const args = (command as { args?: string[] } | null)?.args;
        const ran = args?.at(-1);
        return ran === undefined || ran.trim() === (verifyCommand ?? '').trim();
      };
      const swapped = rows.filter((row) => !matchesDeclaredCommand(row.command)).length;

      const bundle = rows
        .filter((row) => matchesDeclaredCommand(row.command))
        .map((row) => ({
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
            row.produced_at instanceof Date
              ? row.produced_at.toISOString()
              : String(row.produced_at),
          payload: row.payload,
        }));

      // The policy must ask only for what this card can actually produce. The
      // default v0.1 policy demands test + typecheck + build; a card declaring a
      // single `verify:` command can never satisfy three kinds, and a gate that
      // cannot be satisfied is not a gate, it is a wall. One declared command,
      // one required kind.
      // The knowledge-claim gate is opt-in (ADR-0067): it is only required when
      // the workspace turned it on. Reading the flag here is what makes the
      // switch mean something — a capability nothing consults is a setting that
      // reports `enabled: true` while protecting nothing.
      const advancedConfig = await readConfig(layout.root);
      const claimsRequired = advancedConfig?.advanced?.knowledge_claim_gate === true;

      const policy = {
        ...defaultV01Policy(preset),
        evidence: [
          { kind: 'test' as const, required: true, require_fresh: false },
          ...(claimsRequired
            ? [{ kind: 'knowledge-claim' as const, required: true, require_fresh: false }]
            : []),
        ],
      };
      // Entering a terminal stage on a check nobody could read is the hole v007
      // walked through: `verify: echo PASS && exit 0` produced evidence
      // indistinguishable from a real suite. Now that most real runners parse,
      // an unreadable check at the *end* of the ladder is rare enough to be
      // worth stopping — and the escape hatch is a field on the card, so a
      // genuinely unparseable check is declared out loud rather than assumed.
      const acknowledged = data['verify_unparseable'] === true;
      const latest = bundle
        .filter((envelope) => envelope.kind === 'test')
        .sort((a, b) => Date.parse(b.produced_at) - Date.parse(a.produced_at))[0];
      const observed = (latest?.payload as { total?: number } | undefined)?.total ?? 0;
      const readable =
        (latest?.payload as { report?: string } | undefined)?.report === 'parsed' && observed > 0;

      if (isTerminalStage(to) && latest !== undefined && !readable && !acknowledged) {
        refusals.push(
          `gate: ${id}'s check produced no readable test count — \`${verifyCommand ?? ''}\` exited 0 ` +
            'but nothing observed a test run. A command that exits 0 without running anything is ' +
            'indistinguishable from a passing suite here. Point `verify:` at a real runner, or set ' +
            '`verify_unparseable: true` on the card to state plainly that this check cannot be counted.',
        );
      }

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
          if (priorRuns.length === 0 && swapped > 0) {
            refusals.push(
              `gate: ${id} has ${String(swapped)} recorded ${kind} run(s), but none of them ran ` +
                `\`${verifyCommand ?? ''}\` — the card's \`verify:\` changed after they passed. Re-run ` +
                `\`sdlc verify ${id}\`.`,
            );
            continue;
          }
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
      return {
        workItemId: id,
        from,
        to,
        moved: false,
        refusals,
        ...(readiness === undefined ? {} : { readiness }),
      };
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

    // Content is the source of truth: rewrite the card, let sync follow — but
    // only if it still holds what the guards and the gate were evaluated
    // against. A blind write here discards whatever arrived in between, and the
    // discarded write is the one nobody notices.
    const advanced = {
      ...data,
      lifecycle_state: to,
      status: kanbanColumnForStage(to),
      updated_at: new Date().toISOString(),
    };
    await writeCardIfUnchanged(
      found.filePath,
      versionOf(found.raw),
      renderWorkItem(advanced as never, parsed.body.trim() + '\n'),
      id,
    );

    // A soft gate reports on a *successful* move: the work proceeds and the
    // reader is told what was under-specified. Silently dropping the findings
    // here is exactly how a soft gate becomes no gate.
    return {
      workItemId: id,
      from,
      to,
      moved: true,
      refusals: [],
      ...(readiness === undefined ? {} : { readiness }),
    };
  } finally {
    await db.close();
  }
}

export interface ReopenResult {
  readonly workItemId: string;
  readonly from: string;
  readonly to: string;
  readonly reopened: boolean;
  readonly reason: string;
}

/**
 * `sdlc reopen` — the action an unsupported claim was missing.
 *
 * Attestation told the truth and offered nothing to do about it: a `done` with
 * no passing evidence was flagged on every read, forever, and the only way to
 * correct it was to hand-edit the card — the same move that produced the false
 * claim in the first place. A tool that can detect a lie and cannot help you
 * retract it has made the honest path harder than the dishonest one.
 *
 * It refuses on a *supported* claim. This is a correction, not a general "move
 * backwards" command: walking a legitimately-done item back to `implement` is a
 * lifecycle decision, and there is no evidence anywhere that says it should
 * happen. Reversing an unsupported one needs no such judgement — the item's own
 * evidence already says the claim was never true.
 */
export async function reopenWorkItem(
  root: string,
  id: string,
  options: { actor?: string | undefined } = {},
): Promise<ReopenResult> {
  const { resolveWorkspaceLayout } = await import('@sdlc-on-fire/core');
  const layout = resolveWorkspaceLayout(root);
  const found = await findWorkItem(layout.kanbanDir, id);
  if (found === null) throw new Error(`no work item with id "${id}" under ${layout.kanbanDir}`);

  const parsed = parseFrontmatter(found.raw);
  const data = parsed.data;
  const from = typeof data['lifecycle_state'] === 'string' ? data['lifecycle_state'] : '';
  const preset = (typeof data['preset'] === 'string' ? data['preset'] : 'standard') as Preset;
  const workType = typeof data['work_type'] === 'string' ? data['work_type'] : 'feature';

  const { db } = await openWorkspaceDatabase(root);
  try {
    await applySchema(db);
    const port = await PostgresStorageAdapter.create(db);
    await port.upsertWorkItem({
      id,
      type: typeof data['kind'] === 'string' ? data['kind'] : 'task',
      title: typeof data['title'] === 'string' ? data['title'] : id,
      status: kanbanColumnForStage(isLifecycleStage(from) ? from : 'implement'),
      lifecycleState: from,
      workType,
      preset,
      filePath: path.relative(layout.root, found.filePath),
      contentHash: 'pending',
    });

    const ownership = await assertClaimOwnership(port, id, options.actor);
    if (ownership !== null) {
      return { workItemId: id, from, to: from, reopened: false, reason: `claim: ${ownership}` };
    }

    const attested = await attestItem(
      db,
      id,
      from,
      await treeContext(layout.root),
      typeof data['verify'] === 'string' ? data['verify'] : undefined,
    );
    if (attested.attestation !== 'unsupported') {
      return {
        workItemId: id,
        from,
        to: from,
        reopened: false,
        reason:
          attested.attestation === 'supported'
            ? `${id} is "${from}" and its evidence supports that — reopening a legitimately-finished item is a lifecycle decision, not a correction`
            : attested.attestation === 'stale'
              ? `${id} is "${from}" on a run that passed against an earlier tree. That is a prompt to re-run \`sdlc verify ${id}\`, not grounds to retract the claim — reopening honest work because someone else edited a file is how a warning stops being read`
              : `${id} is at "${from}", which is not a terminal claim — there is nothing to retract`,
      };
    }

    // Back to the last stage that produces something checkable, not to the very
    // start. The work was done; what was never true is the claim that it passed.
    const ladder = resolveRequiredStages(preset, workType) ?? [];
    const to = ladder.includes('implement') ? 'implement' : (ladder[0] ?? 'implement');

    // Same shape as `advance`: the card is rewritten, unmodelled frontmatter
    // keys preserved, and the mirror follows on the next sync.
    const rewritten = renderWorkItem(
      {
        ...data,
        lifecycle_state: to,
        status: kanbanColumnForStage(to),
        updated_at: new Date().toISOString(),
      } as never,
      parsed.body.trim() + '\n',
    );
    await writeCardIfUnchanged(found.filePath, versionOf(found.raw), rewritten, id);

    return {
      workItemId: id,
      from,
      to,
      reopened: true,
      reason: attested.concern ?? 'the claim was not supported by evidence',
    };
  } finally {
    await db.close();
  }
}
