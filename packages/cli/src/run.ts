import { randomUUID } from 'node:crypto';
import {
  applyRetrievalBudget,
  contextPackPath,
  loadTierPolicy,
  needsDiversity,
  pickDiverseModel,
  resolveStageProfile,
  resolveWorkspaceLayout,
  tolerantRecorder,
  type LifecycleStage,
  type RunRecorder,
} from '@sdlc-on-fire/core';
import { assembleContextPack, estimateTokens, renderCacheAware } from '@sdlc-on-fire/context';
import { persistContextPack } from '@sdlc-on-fire/storage';
import {
  claudeCodeTransport,
  dispatchSkill,
  getSkill,
  resolveTier,
  tierPolicyFromConfig,
  type AgentTransport,
} from '@sdlc-on-fire/agent-manager';
import { applySchema, PostgresStorageAdapter } from '@sdlc-on-fire/db';
import { instructions, openWorkspaceDatabase, readConfig } from './commands.js';

/**
 * `sdlc run` (P6-SURFACE-11) — the caller everything else was missing.
 *
 * Found while building P6-INSTRUMENT-02, and it is the largest gap the feature
 * audit turned up. `dispatchSkill` had **no production caller**. Neither did
 * `assembleContextPack`, and with it the whole context package — layering,
 * budget truncation, cache-aware rendering, provenance. `persistContextPack`
 * had none. The `runs` table had none, which is why P6-WRITEPATH-01 found it
 * permanently empty.
 *
 * Each of those pieces was built, tested and reachable from its own unit tests,
 * and no command in the product ever ran one. That is the shape this phase
 * exists to close, at its largest: a subsystem that looks finished from every
 * angle except the one that matters.
 *
 * **This is not the primary way the product is used, and that is why the gap
 * survived.** The intended path is a person in an agent chat window invoking a
 * compiled skill — `sdlc instructions` hands them the prompt and the agent they
 * are already talking to does the work. `sdlc run` is the headless path: CI, a
 * daemon, a script, anyone who wants the loop closed without a human in a chat
 * window. Both needed to exist; only one did.
 *
 * **The order of operations is the design**, and each step is placed where it is
 * because of how the alternative fails:
 *
 * 1. Resolve the skill for the stage the card is AT (contract 02 §3.2).
 * 2. Assemble the pack, and refuse if the budget cannot hold the card itself.
 * 3. Persist the pack **before** dispatching — "what were we even asking it to
 *    do" is the first question anybody has about a run that hung.
 * 4. Record the run row **before** the transport call, for the same reason.
 * 5. Dispatch. Whatever happens, the row is finished with a reason and a cost.
 */

export class NotRunnableError extends Error {
  override readonly name = 'NotRunnableError';
  constructor(
    readonly workItemId: string,
    because: string,
  ) {
    super(`${workItemId} cannot be run: ${because}`);
  }
}

export interface RunResult {
  readonly workItemId: string;
  readonly runId: string;
  readonly stage: string;
  readonly skill: string;
  readonly model: string;
  readonly contextPackPath: string;
  readonly packTokens: number;
  /** Layers the profile wanted and the budget or the corpus did not supply. */
  readonly droppedLayers: readonly string[];
  readonly durationMs: number;
  /** True when the primary model was skipped because it had already worked on this item. */
  readonly avoidedPrimaryModel?: boolean | undefined;
  /** The skill's structured output, exactly as it validated. */
  readonly output: Record<string, unknown>;
}

export interface RunOptions {
  /** Injectable so tests never spend tokens. Production passes nothing. */
  readonly transport?: AgentTransport | undefined;
  /** Assemble, persist and record, then stop before the transport call. */
  readonly dryRun?: boolean | undefined;
  readonly runId?: string | undefined;
}

export interface DryRunResult {
  readonly workItemId: string;
  readonly runId: string;
  readonly stage: string;
  readonly skill: string;
  readonly model: string;
  readonly contextPackPath: string;
  readonly packTokens: number;
  readonly droppedLayers: readonly string[];
  readonly avoidedPrimaryModel?: boolean | undefined;
  readonly dryRun: true;
}

export async function runWorkItem(
  root: string,
  id: string,
  options: RunOptions = {},
): Promise<RunResult | DryRunResult> {
  const layout = resolveWorkspaceLayout(root);

  // Reuses `instructions` rather than re-deriving the stage and the skill. Two
  // code paths answering "what should this card do next" is how they come to
  // disagree, and this one would disagree silently — the run would simply be of
  // a different skill than the one the user was shown.
  const plan = await instructions(root, id);
  if (plan.skill === null) {
    throw new NotRunnableError(id, plan.reason ?? 'no skill drives its current stage');
  }

  const skill = getSkill(plan.skill.name);
  if (skill === undefined) {
    throw new NotRunnableError(id, `"${plan.skill.name}" is not a registered skill`);
  }

  const stage = plan.workItem.stage as LifecycleStage;
  const profile = resolveStageProfile(stage);
  const config = await readConfig(root);
  const tier = resolveTier(skill, tierPolicyFromConfig(loadTierPolicy(config?.agents)));
  if (tier.model === undefined) {
    throw new NotRunnableError(
      id,
      `no model is configured for the "${tier.tier}" tier — set agents.models in the workspace config`,
    );
  }

  /* -- the pack ------------------------------------------------------------ */

  const runId = options.runId ?? randomUUID();
  const assembled = await assembleContextPack({
    spec: {
      skillId: skill.name,
      stageId: stage,
      // The stage's own ceiling, not a constant. This is where P6-PERSTAGE-02's
      // budget stops being a number in a table and starts costing something.
      budget: {
        max: Math.max(profile.retrievalBudget, estimateTokens(plan.context?.cardCore ?? '') + 2048),
      },
      sources: { include: [] },
      freshness: { revalidateOnAssembly: true },
      isolation: skill.context_mode === 'fork' ? 'fresh-subagent' : 'inline',
      disposer: 'assembleContextPack.truncateToBudget',
    },
    cardId: id,
    effortTier: profile.effortTier,
    skillStable: plan.context?.skillStable ?? '',
    cardCore: plan.context?.cardCore ?? '',
  });

  // Concatenated from the two halves rather than re-serialised. `renderCacheAware`
  // splits the pack at the cache breakpoint, and the prefix must be reproduced
  // byte-for-byte on the next call or the cache misses silently at full price —
  // so the file on disk is exactly what was sent, joined the same way.
  const render = renderCacheAware(assembled.pack);
  const rendered = `${render.prefix}${render.suffix}`;

  // Written before the agent runs, and never overwritten. The file is evidence
  // of what was actually sent; rewriting it for a re-run under the same id makes
  // the record disagree with what happened, in the direction of the most recent
  // attempt (P6-WRITEPATH-03).
  const pack = await persistContextPack(layout.root, runId, rendered);

  /* -- the row ------------------------------------------------------------- */

  const { db } = await openWorkspaceDatabase(root);
  await applySchema(db);
  const port = await PostgresStorageAdapter.create(db);

  // The card is mirrored before the run row is written, because `runs.work_item_id`
  // is a foreign key: a run belongs to a work item or it is not a run of
  // anything. Without this the insert violates the constraint, the tolerant
  // recorder swallows it exactly as designed — telemetry must never break the
  // work — and the runs table stays empty while every command reports success.
  // Which is precisely how it stayed empty for four phases.
  await port.upsertWorkItem({
    id,
    type: plan.workItem.kind,
    title: plan.workItem.title,
    status: 'In progress',
    lifecycleState: stage,
    workType: plan.workItem.workType,
    preset: plan.workItem.preset,
    riskLevel: 'low',
    parentId: null,
    filePath: plan.workItem.filePath,
    // The pack is content-addressed elsewhere; this mirror row exists to satisfy
    // the foreign key and is rebuilt from git by `db:rebuild` like every other.
    contentHash: pack.relativePath,
  });

  const problems: string[] = [];
  const recorder: RunRecorder = tolerantRecorder(
    { start: (r) => port.startRun(r), finish: (r) => port.finishRun(r) },
    (where, because) => problems.push(`${where}: ${because}`),
  );

  try {
    const dropped = assembled.dropped
      .filter((layer) => layer.reason === 'budget')
      .map((layer) => layer.kind);

    // Enforced adversarial diversity (P6-SURFACE-09). A model reviewing its own
    // output is not a second opinion — it is the same model asked twice, and it
    // agrees with itself for the same reasons it was wrong the first time.
    //
    // The exclusion set comes from the run rows, which is the only place that
    // knows what actually ran. Asking the config would answer what is *supposed*
    // to run, and the two differ exactly when a fallback fired.
    let model = tier.model;
    let avoided = false;
    if (needsDiversity(stage)) {
      const priorModels = await db.query<{ model: string | null }>(
        `SELECT DISTINCT model FROM runs
          WHERE work_item_id = $1 AND model IS NOT NULL AND status = 'pass';`,
        [id],
      );
      const choice = pickDiverseModel(
        [tier.model, ...tier.fallbacks],
        priorModels.map((row) => row.model ?? ''),
        tier.tier,
      );
      model = choice.model;
      avoided = choice.avoided;
    }

    if (options.dryRun === true) {
      // A dry run still writes the pack and still mints the id, because the
      // question it answers is "what would this agent be handed" — and a dry run
      // that assembles a different pack than the real one answers nothing. It
      // does NOT record a run row: nothing ran, and a row saying otherwise is
      // the kind of telemetry that makes a table untrustworthy.
      return {
        workItemId: id,
        runId,
        stage,
        skill: skill.name,
        model,
        contextPackPath: pack.relativePath,
        packTokens: assembled.pack.totalTokens,
        droppedLayers: dropped,
        dryRun: true,
        ...(avoided ? { avoidedPrimaryModel: true } : {}),
      };
    }

    const result = await dispatchSkill(
      {
        skill,
        variables: { work_item_id: id, verify_command: 'sdlc verify' },
        cwd: layout.root,
        recorder,
        runId,
        workItemId: id,
        model,
        contextPackPath: pack.relativePath,
      },
      options.transport ?? claudeCodeTransport(),
    );

    return {
      workItemId: id,
      runId,
      stage,
      skill: skill.name,
      model,
      contextPackPath: pack.relativePath,
      packTokens: assembled.pack.totalTokens,
      droppedLayers: dropped,
      durationMs: result.durationMs,
      ...(avoided ? { avoidedPrimaryModel: true } : {}),
      output: result.output,
    };
  } finally {
    await db.close().catch(() => undefined);
    // Reported, never swallowed. A recorder that has quietly stopped working is
    // how the runs table stayed empty through an entire phase.
    for (const problem of problems) process.stderr.write(`run recording problem — ${problem}\n`);
  }
}

export function formatRun(result: RunResult | DryRunResult): string {
  const lines = [
    'dryRun' in result
      ? `${result.workItemId} — would run "${result.skill}" at ${result.stage}`
      : `${result.workItemId} — ran "${result.skill}" at ${result.stage}`,
    `  run:    ${result.runId}`,
    `  model:  ${result.model}`,
    `  pack:   ${result.contextPackPath} (~${String(result.packTokens)} tokens)`,
  ];
  if (result.avoidedPrimaryModel === true) {
    // Said out loud. A review that quietly ran on a fallback because the primary
    // had already touched this item is a routing decision the reader should see,
    // not infer from a model name.
    lines.push('  (fell back — the primary model had already worked on this item)');
  }
  if (result.droppedLayers.length > 0) {
    // Named, not counted. A pack silently missing retrieval because of a ceiling
    // is indistinguishable from one where retrieval found nothing.
    lines.push(`  dropped to fit the budget: ${result.droppedLayers.join(', ')}`);
  }
  if (!('dryRun' in result)) {
    lines.push(
      `  took:   ${String(result.durationMs)}ms`,
      '',
      JSON.stringify(result.output, null, 2),
    );
  }
  return lines.join('\n');
}

export { contextPackPath, applyRetrievalBudget };
