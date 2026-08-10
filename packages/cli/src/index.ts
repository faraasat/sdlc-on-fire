// No shebang here: tsup injects one via `banner` (tsup.config.ts). Declaring it
// in the source too produces a duplicate on line 2 of the bundle, which is a
// syntax error — and one that no unit test can see, because tests import the
// module rather than executing the built binary.
import { existsSync } from 'node:fs';
import { Command } from 'commander';
import { createRequire } from 'node:module';
import { agentManagerPackage } from '@sdlc-on-fire/agent-manager';
import { daemonPackage } from '@sdlc-on-fire/daemon';
import { dbPackage } from '@sdlc-on-fire/db';
import {
  corePackage,
  formatWorkItemId,
  kanbanColumnForStage,
  PRESETS,
  PresetSchema,
  resolveRequiredStages,
  resolveWorkspaceLayout,
  WORK_ITEM_ID_PREFIX,
  type PackageInfo,
  type Preset,
} from '@sdlc-on-fire/core';
import { renderWorkItem } from '@sdlc-on-fire/storage';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  init,
  instructions,
  nextSequence,
  rebuild,
  syncBatch,
  hooksInstall,
  listWorkItems,
  claimWorkItem,
  captureItem,
  triageItem,
  showConfig,
  describeAgents,
  status,
  type InstructionsResult,
} from './commands.js';
import { advanceWorkItem } from './advance.js';
import { reopenWorkItem, verifyWorkItem } from './advance.js';
import { branchFor, type BranchResult } from './branch.js';

export * from './commands.js';

/** Identity of the published `sdlc-on-fire` package. */
export const cliPackage: PackageInfo = {
  name: 'sdlc-on-fire',
  dependsOn: [
    '@sdlc-on-fire/core',
    '@sdlc-on-fire/db',
    '@sdlc-on-fire/daemon',
    '@sdlc-on-fire/agent-manager',
  ],
};

/** Resolved dependency identities — proves the workspace links are real, not just declared. */
export const cliDependencies: readonly PackageInfo[] = [
  corePackage,
  dbPackage,
  daemonPackage,
  agentManagerPackage,
];

/**
 * The `sdlc` CLI (contracts/13, P0-CLI-01).
 *
 * Every command has a `--json` twin. Both render the **same value** returned by
 * the command function — the JSON path is a serializer, never a second
 * implementation, because two implementations of "what is the status" is how
 * they end up disagreeing.
 */

function emit(value: unknown, json: boolean, human: (value: never) => string): void {
  process.stdout.write(json ? `${JSON.stringify(value, null, 2)}\n` : `${human(value as never)}\n`);
}

/** Read from package.json so the flag cannot drift from what was published. */
const CLI_VERSION: string = (
  createRequire(import.meta.url)('../package.json') as { version: string }
).version;

export function buildProgram(): Command {
  const program = new Command();

  program
    .name('sdlc')
    .description('SDLC on Fire — a daemon that will not let the agent lie')
    // `--version` is the first thing anyone types at an unfamiliar CLI, and its
    // absence reads as an unfinished tool before a single real command is run.
    .version(CLI_VERSION, '-v, --version', 'print the version and exit')
    .option('-C, --cwd <path>', 'run against a different workspace root', process.cwd());

  /**
   * The workspace root, verified to exist.
   *
   * A typo'd `-C` previously reported `initialised: no` for a path that was not
   * there at all — indistinguishable from a real but empty directory, and the
   * wrong answer to give someone who has just mistyped a path.
   */
  const root = (): string => {
    const value = String(program.opts()['cwd'] ?? process.cwd());
    if (!existsSync(value)) {
      throw new Error(`no such directory: ${value} (from -C/--cwd)`);
    }
    return value;
  };

  program
    .command('init')
    .description('scaffold the workspace (never overwrites an existing file)')
    .option('--json', 'emit JSON')
    .action(async (options: { json?: boolean }) => {
      const result = await init(root());
      emit(result, options.json === true, (r: Awaited<ReturnType<typeof init>>) =>
        [
          r.alreadyInitialised ? 'Workspace already initialised.' : 'Workspace initialised.',
          `  root:    ${r.root}`,
          `  created: ${r.created.length} file(s)`,
          `  skipped: ${r.skipped.length} existing file(s)`,
        ].join('\n'),
      );
    });

  program
    .command('status')
    .description('report workspace state')
    .option('--json', 'emit JSON')
    .action(async (options: { json?: boolean }) => {
      const result = await status(root());
      emit(result, options.json === true, (r: Awaited<ReturnType<typeof status>>) =>
        [
          `initialised: ${r.initialised ? 'yes' : 'no'}`,
          `root:        ${r.root}`,
          `database:    ${r.databaseMode ?? '(not configured)'}`,
          `work items:  ${r.counts.workItems ?? '(daemon not running)'}`,
        ].join('\n'),
      );
    });

  program
    .command('new')
    .argument('<kind>', 'epic | story | feature | bug | task')
    .argument('<title>', 'human-readable title')
    .description('create a work item')
    .option('--preset <preset>', 'lite | standard | strict', 'standard')
    .option('--json', 'emit JSON')
    .action(
      async (
        kind: string,
        title: string,
        options: { preset?: string; json?: boolean },
      ): Promise<void> => {
        if (!(kind in WORK_ITEM_ID_PREFIX)) {
          throw new Error(
            `unknown kind "${kind}" — expected one of ${Object.keys(WORK_ITEM_ID_PREFIX).join(', ')}`,
          );
        }
        const typedKind = kind as keyof typeof WORK_ITEM_ID_PREFIX;

        // Validate rather than cast. Casting an unrecognised preset let it reach
        // the ladder resolver, which returned undefined and crashed with a raw
        // TypeError several frames later — an error that named neither the flag
        // nor the valid values.
        const presetParsed = PresetSchema.safeParse(options.preset ?? 'standard');
        if (!presetParsed.success) {
          throw new Error(
            `unknown preset "${String(options.preset)}" — expected one of ${PRESETS.join(', ')}`,
          );
        }
        const preset: Preset = presetParsed.data;
        // An atomic task gets the task effort profile (ADR-0070); everything
        // else keeps the profile matching its kind.
        const workType = typedKind === 'bug' ? 'bug' : typedKind === 'task' ? 'task' : 'feature';

        const stages = resolveRequiredStages(preset, workType);
        const firstStage = stages?.[0];
        if (firstStage === undefined) {
          throw new Error(`no stage ladder for preset "${preset}" + work_type "${workType}"`);
        }

        const layout = resolveWorkspaceLayout(root());
        const sequence = await nextSequence(layout.kanbanDir, WORK_ITEM_ID_PREFIX[typedKind]);
        const id = formatWorkItemId(typedKind, sequence);
        const now = new Date().toISOString();

        const base = {
          $schema: 'https://sdlc-on-fire.dev/schema/work-item.json',
          id,
          kind: typedKind,
          title,
          status: kanbanColumnForStage(firstStage),
          lifecycle_state: firstStage,
          work_type: workType,
          preset,
          risk_level: 'low' as const,
          created_at: now,
          updated_at: now,
          ...(typedKind === 'task' ? { verify: 'pnpm test', done: ['tests pass'] } : {}),
          ...(typedKind === 'bug' ? { repro_steps: ['TODO'], severity: 'medium' as const } : {}),
          ...(typedKind === 'story' ? { acceptance_criteria: ['GIVEN … WHEN … THEN …'] } : {}),
          ...(typedKind === 'feature'
            ? { acceptance_criteria: ['GIVEN … WHEN … THEN …'], spec_ref: 'TODO' }
            : {}),
          ...(typedKind === 'epic' ? { goal: 'TODO' } : {}),
        };

        const filePath = path.join(layout.kanbanDir, '_inbox', `${id}.md`);
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(
          filePath,
          renderWorkItem(base as never, `## Description\n\nTODO\n`),
          'utf8',
        );

        const result = { id, filePath, kind: typedKind };
        emit(
          result,
          options.json === true,
          (r: typeof result) => `Created ${r.id} at ${r.filePath}`,
        );
      },
    );

  program
    .command('instructions')
    .argument('<work-item-id>', 'the work item to report on, e.g. FEAT-001')
    .description('report the next step, its skill template, and the context for a work item')
    .option('--json', 'emit JSON')
    .action(async (id: string, options: { json?: boolean }): Promise<void> => {
      const result = await instructions(root(), id);
      emit(result, options.json === true, (r: InstructionsResult) => {
        const lines = [
          `${r.workItem.id} — ${r.workItem.title}`,
          `  stage:  ${r.workItem.stage} (${r.workItem.preset}/${r.workItem.workType})`,
          `  next:   ${r.nextStage ?? '(none — terminal)'}`,
        ];
        // The concern goes above the skill, not below it: an agent reading this
        // to decide what to do next must see "this item's `done` is not backed
        // by evidence" before anything that looks like an instruction.
        if (r.attestation === 'unsupported') {
          lines.push(`  ⚠ UNSUPPORTED CLAIM: ${r.concern ?? 'no passing evidence'}`);
        }
        if (r.skill === null) {
          lines.push(`  skill:  none — ${r.reason ?? ''}`);
        } else {
          lines.push(
            `  skill:  ${r.skill.name} → ${r.skill.outputContract.toolName}`,
            `  tokens: ~${String(r.context?.estimatedTokens ?? 0)}`,
            '',
            r.skill.task,
          );
        }
        return lines.join('\n');
      });
    });

  program
    .command('db:rebuild')
    .description('drop the DB mirror and reconstruct it from the files in git')
    .option('--json', 'emit JSON')
    .action(async (options: { json?: boolean }): Promise<void> => {
      const result = await rebuild(root());
      emit(result, options.json === true, (r: Awaited<ReturnType<typeof rebuild>>) =>
        [
          `Rebuilt mirror from ${r.root}`,
          `  work items: ${String(r.workItems)}`,
          `  docs:       ${String(r.docs)}`,
          `  changed:    ${String(r.changed)}`,
          `  failed:     ${String(r.failed.length)}`,
          `  took:       ${String(r.durationMs)}ms`,
          ...r.failed.map((f) => `    ! ${f.relativePath}: ${f.error}`),
        ].join('\n'),
      );
      // A rebuild that silently exits 0 with failures reads as success in any
      // script that checks the exit code, which is every script.
      if (result.failed.length > 0) process.exitCode = 1;
    });

  program
    .command('sync:batch')
    .description('re-sync the paths a git operation just changed (used by the installed hooks)')
    .option('--since <ref>', 'commit whose changed paths to sync', 'HEAD')
    .option('--json', 'emit JSON')
    .action(async (options: { since?: string; json?: boolean }): Promise<void> => {
      const result = await syncBatch(root(), options.since ?? 'HEAD');
      emit(result, options.json === true, (r: Awaited<ReturnType<typeof syncBatch>>) =>
        [
          `Synced ${String(r.considered)} managed path(s)`,
          `  upserted: ${String(r.upserted)}`,
          `  deleted:  ${String(r.deleted)}`,
          `  failed:   ${String(r.failed.length)}`,
          ...r.failed.map((f) => `    ! ${f.relativePath}: ${f.error}`),
        ].join('\n'),
      );
    });

  program
    .command('hooks:install')
    .description('install the git hooks that keep the mirror current across merges and checkouts')
    .option('--json', 'emit JSON')
    .action(async (options: { json?: boolean }): Promise<void> => {
      const result = await hooksInstall(root());
      emit(result, options.json === true, (r: Awaited<ReturnType<typeof hooksInstall>>) =>
        [
          `Installed ${String(r.installed.length)} hook(s) in ${r.root}`,
          ...r.installed.map((hook) => `  + ${hook}`),
          ...r.skipped.map((entry) => `  ~ ${entry.hook} skipped — ${entry.reason}`),
        ].join('\n'),
      );
    });

  program
    .command('capture')
    .argument('<note...>', 'what you noticed, in a sentence')
    .description('capture an idea into the inbox without interrupting what you are doing')
    .option('--json', 'emit JSON')
    .action(async (note: string[], options: { json?: boolean }): Promise<void> => {
      const result = await captureItem(root(), note.join(' '));
      emit(
        result,
        options.json === true,
        (r: Awaited<ReturnType<typeof captureItem>>) =>
          `${r.id} captured → ${r.filePath}\n  Triage it later with \`sdlc triage ${r.id} --as <kind>\`.`,
      );
    });

  program
    .command('triage')
    .argument('<capture-id>', 'the capture to promote, e.g. CAP-001')
    .requiredOption('--as <kind>', 'epic | story | feature | bug | task')
    .option('--preset <preset>', 'lite | standard | strict', 'standard')
    .description('turn a capture into a real work item')
    .option('--json', 'emit JSON')
    .action(
      async (
        capturedId: string,
        options: { as: string; preset?: string; json?: boolean },
      ): Promise<void> => {
        const result = await triageItem(
          root(),
          capturedId,
          options.as,
          options.preset ?? 'standard',
        );
        emit(
          result,
          options.json === true,
          (r: Awaited<ReturnType<typeof triageItem>>) =>
            `${r.capturedId} → ${r.workItemId} (${r.kind}) at ${r.filePath}`,
        );
      },
    );

  program
    .command('claim')
    .argument('<work-item-id>', 'the work item to claim')
    .option('--as <actor>', 'who is claiming it', process.env['USER'] ?? 'local')
    .option('--minutes <n>', 'lease length in minutes', '60')
    .description('take a work item before starting on it, so two actors cannot both own it')
    .option('--json', 'emit JSON')
    .action(
      async (
        id: string,
        options: { as?: string; minutes?: string; json?: boolean },
      ): Promise<void> => {
        const result = await claimWorkItem(
          root(),
          id,
          options.as ?? 'local',
          Number.parseInt(options.minutes ?? '60', 10),
        );
        emit(result, options.json === true, (r: Awaited<ReturnType<typeof claimWorkItem>>) =>
          r.granted
            ? `${r.workItemId} claimed by ${r.claimedBy} until ${r.leaseExpiresAt}`
            : `${r.workItemId} is already held by ${r.heldBy ?? '(unknown)'}`,
        );
        if (!result.granted) process.exitCode = 1;
      },
    );

  program
    .command('verify')
    .argument('<work-item-id>', 'the work item whose verify command to run')
    .description("run the work item's own verify command and record the result as evidence")
    .option('--as <actor>', 'who is running the check', process.env['USER'] ?? 'local')
    .option('--json', 'emit JSON')
    .action(async (id: string, options: { as?: string; json?: boolean }): Promise<void> => {
      const result = await verifyWorkItem(root(), id, { actor: options.as });
      emit(result, options.json === true, (r: Awaited<ReturnType<typeof verifyWorkItem>>) =>
        [
          `${r.workItemId}: ${r.summary}`,
          `  command:  ${r.command}`,
          `  exit:     ${String(r.exitCode)}  (${String(r.durationMs)}ms)`,
          `  evidence: #${String(r.evidenceId)} recorded by the daemon, not claimed by an agent`,
        ].join('\n'),
      );
      if (!result.ok) process.exitCode = 1;
    });

  program
    .command('advance')
    .argument('<work-item-id>', 'the work item to move to its next stage')
    .description('move a work item to its next lifecycle stage, if the guards and gate allow it')
    .option(
      '--as <actor>',
      'who is advancing it — must hold the claim',
      process.env['USER'] ?? 'local',
    )
    .option('--json', 'emit JSON')
    .action(async (id: string, options: { as?: string; json?: boolean }): Promise<void> => {
      const result = await advanceWorkItem(root(), id, { actor: options.as });
      emit(result, options.json === true, (r: Awaited<ReturnType<typeof advanceWorkItem>>) =>
        r.moved
          ? `${r.workItemId}: ${r.from} → ${r.to}`
          : [
              `${r.workItemId}: BLOCKED at "${r.from}"${r.to === null ? '' : ` (wanted "${r.to}")`}`,
              ...r.refusals.map((reason) => `  ✗ ${reason}`),
            ].join('\n'),
      );
      if (!result.moved) process.exitCode = 1;
    });

  program
    .command('branch')
    .argument('<work-item-id>', 'the work item to name a branch for, e.g. TASK-001')
    .description("derive a work item's branch name from its hierarchy, and optionally create it")
    .option('--as <actor>', 'who is claiming the work — required with --create')
    .option('--create', 'actually create and check out the branch')
    .option('--json', 'emit JSON')
    .action(
      async (
        id: string,
        options: { as?: string; create?: boolean; json?: boolean },
      ): Promise<void> => {
        const result = await branchFor(root(), id, {
          actor: options.as,
          create: options.create,
        });
        emit(result, options.json === true, (r: BranchResult) =>
          [
            r.branch,
            r.hierarchy.length === 0
              ? '  (no parent hierarchy — name derives from the item alone)'
              : `  under: ${r.hierarchy.map((entry) => `${entry.id} (${entry.kind})`).join(' → ')}`,
            r.created ? '  created and checked out' : '',
            r.refusal === undefined ? '' : `  ✗ ${r.refusal}`,
          ]
            .filter((line) => line !== '')
            .join('\n'),
        );
        if (result.refusal !== undefined) process.exitCode = 1;
      },
    );

  program
    .command('reopen')
    .argument('<work-item-id>', 'the work item whose terminal claim is not supported')
    .description('retract a done/terminal claim that its own evidence does not support')
    .option(
      '--as <actor>',
      'who is retracting it — must hold the claim',
      process.env['USER'] ?? 'local',
    )
    .option('--json', 'emit JSON')
    .action(async (id: string, options: { as?: string; json?: boolean }): Promise<void> => {
      const result = await reopenWorkItem(root(), id, { actor: options.as });
      emit(result, options.json === true, (r: Awaited<ReturnType<typeof reopenWorkItem>>) =>
        r.reopened
          ? `${r.workItemId}: ${r.from} → ${r.to}\n  reason: ${r.reason}`
          : `${r.workItemId}: not reopened\n  ✗ ${r.reason}`,
      );
      if (!result.reopened) process.exitCode = 1;
    });

  program
    .command('list')
    .description('list work items in the mirror')
    .option('--json', 'emit JSON')
    .action(async (options: { json?: boolean }): Promise<void> => {
      const result = await listWorkItems(root());
      emit(result, options.json === true, (r: Awaited<ReturnType<typeof listWorkItems>>) =>
        r.items.length === 0
          ? 'No work items yet. Create one with `sdlc new feature "..."`.'
          : r.items
              .flatMap((item) => [
                `${item.attestation === 'unsupported' ? '⚠' : ' '} ${item.id.padEnd(12)} ${item.lifecycleState.padEnd(16)} ${item.title}`,
                ...(item.concern === undefined ? [] : [`    ↳ ${item.concern}`]),
              ])
              .join('\n'),
      );
    });

  program
    .command('agents')
    .description('show which model each skill routes to, and why')
    .option('--json', 'emit JSON')
    .action(async (options: { json?: boolean }): Promise<void> => {
      const result = await describeAgents(root());
      emit(result, options.json === true, (r: Awaited<ReturnType<typeof describeAgents>>) =>
        [
          `max tier: ${r.maxTier}`,
          ...Object.entries(r.models).map(([tier, model]) => `  ${tier.padEnd(7)} ${model}`),
          '',
          ...r.routes.map(
            (route) =>
              `  ${route.skill.padEnd(14)} ${route.tier.padEnd(7)} ${route.model}  (${route.source})`,
          ),
          ...r.unroutable.map((entry) => `  ✗ ${entry.skill}: ${entry.reason}`),
        ].join('\n'),
      );
      if (result.unroutable.length > 0) process.exitCode = 1;
    });

  program
    .command('config')
    .description('show the resolved workspace config')
    .option('--json', 'emit JSON')
    .action(async (options: { json?: boolean }) => {
      const result = await showConfig(root());
      emit(result, options.json === true, (r: Awaited<ReturnType<typeof showConfig>>) =>
        r.config === null
          ? `No config at ${r.configPath} — run \`sdlc init\` first.`
          : [
              JSON.stringify(r.config, null, 2),
              // A flag reading `enabled: true` while nothing reads it is the one
              // thing a user most needs told, so it goes below the config where
              // it cannot be lost in the table.
              ...(r.inert.length === 0
                ? []
                : [
                    '',
                    `⚠ ${String(r.inert.length)} enabled capability/capabilities are declared but not yet wired —`,
                    '  turning them on changes nothing today:',
                    ...r.inert.map((entry) => `    ${entry.key} (lands in ${entry.lands_in})`),
                  ]),
            ].join('\n'),
      );
    });

  return program;
}

// Only run when invoked as the binary, so importing this module in tests does
// not parse the test runner's own argv.
if (process.argv[1] !== undefined && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  buildProgram()
    .parseAsync(process.argv)
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
