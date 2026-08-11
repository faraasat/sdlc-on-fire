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
  APPETITES,
  AppetiteSchema,
  PRESETS,
  PresetSchema,
  resolveRequiredStages,
  resolveWorkspaceLayout,
  WORK_ITEM_ID_PREFIX,
  type PackageInfo,
  type Preset,
  AmbiguitySchema,
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
import { auditDependencies } from './audit.js';
import { branchFor, type BranchResult } from './branch.js';
import { prFor } from './pr.js';
import { recordReview } from './review.js';
import { formatClaims, verifyWorkItemClaims } from './claims.js';
import { scoreWorkItem } from './spec-score.js';
import { approveEchoBack, readEchoBack, recordEchoBack } from './echo.js';
import { directivesFor, postComment } from './comment.js';
import { checkDocs, formatDocsCheck } from './docs-check.js';
import {
  checkGuide,
  createInitiative,
  docHealth,
  formatDocHealth,
  formatGuideCheck,
  INITIATIVE_KINDS,
  type InitiativeKind,
} from './initiative.js';
import { queueFor } from './queue.js';
import { detectTools, formatDetect } from './detect.js';
import { checkDependencies, formatDepsCheck } from './deps.js';
import { scanWorkspace, formatScan } from './scan.js';
import { formatImport, runImport, type ConflictPolicy } from './import.js';
import { compileSkills, doctorSkills, formatCompile, formatDoctor } from './skills.js';
import { scanQuality } from './quality.js';
import {
  listMemory,
  memoryHistory as memoryHistoryFor,
  recordMemory as recordMemoryEntry,
} from './memory.js';

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

/** Accumulates a repeatable option into an array. */
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/** Splits a comma-separated option into trimmed, non-empty entries. */
function splitList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

/** A non-dry-run import that did not commit is a failure, whatever it printed. */
function r_committed(result: { dryRun: boolean; committed: boolean }): boolean {
  return result.dryRun || result.committed;
}

function emit(value: unknown, json: boolean, human: (value: never) => string): void {
  process.stdout.write(json ? `${JSON.stringify(value, null, 2)}\n` : `${human(value as never)}\n`);
}

/**
 * Blocks until the person at the keyboard types the work item's id.
 *
 * The TTY check alone proves a terminal exists, not that anyone read anything —
 * an agent driving a pty would satisfy it. Typing the id back is cheap for a
 * human who is present and is the second thing an unattended caller cannot do.
 */
async function confirmAtTerminal(id: string): Promise<void> {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(
      `Approving ${id} says a human read the agent's understanding and agrees.\n` +
        `Type ${id} to confirm: `,
    );
    if (answer.trim() !== id)
      throw new Error(`${id}: not approved — the confirmation did not match`);
  } finally {
    rl.close();
  }
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
          r.initialisedGit
            ? '  git:     initialised a repository (content in git is how this tool stores work)'
            : '',
          r.database.ready ? '  db:      PGlite ready' : `  db:      ⚠ ${r.database.detail}`,
        ]
          .filter((line) => line !== '')
          .join('\n'),
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
    .option('--appetite <appetite>', 'small-batch | big-batch (epics and features only)')
    .option(
      '--blocked-by <ids>',
      'comma-separated work items that must finish first — drives `sdlc queue`',
    )
    .option('--owns <globs>', 'comma-separated file globs this item owns, for wave packing')
    .option('--json', 'emit JSON')
    .action(
      async (
        kind: string,
        title: string,
        options: {
          preset?: string;
          appetite?: string;
          blockedBy?: string;
          owns?: string;
          json?: boolean;
        },
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
        // An appetite is a scoping decision about a whole body of work; a task
        // inherits its parent's. Silently accepting one on a task would record a
        // decision at a level where it means nothing.
        if (options.appetite !== undefined && typedKind !== 'epic' && typedKind !== 'feature') {
          throw new Error(
            `--appetite applies to epics and features, not to a ${typedKind}. ` +
              "A task's appetite is its parent's.",
          );
        }
        const appetiteParsed =
          options.appetite === undefined ? null : AppetiteSchema.safeParse(options.appetite);
        if (appetiteParsed !== null && !appetiteParsed.success) {
          throw new Error(
            `unknown appetite "${String(options.appetite)}" — expected one of ${APPETITES.join(', ')}`,
          );
        }

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
          ...(appetiteParsed === null ? {} : { appetite: appetiteParsed.data }),
          // Emitted only when declared. `blocked_by` and `file_ownership` drive
          // `sdlc queue`, and until they were reachable from `new` the scheduler
          // looked to a first-time user like it ordered by creation date — the
          // fields existed on the schema and nothing ever wrote them.
          ...(splitList(options.blockedBy).length === 0
            ? {}
            : { blocked_by: splitList(options.blockedBy) }),
          ...(splitList(options.owns).length === 0
            ? {}
            : { file_ownership: splitList(options.owns) }),
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
            `  tokens: ~${String(r.context?.estimatedTokens ?? 0)}` +
              (r.context === null
                ? ''
                : ` (${String(r.context.cacheablePrefixTokens)} cacheable, ` +
                  `${String(Math.round(r.context.cacheableFraction * 100))}%)`),
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
          // A fallback that only shows up as a lower confidence score in the DB
          // is a fallback nobody acts on. Naming the remedy is the difference
          // between 0.6-confidence evidence forever and a one-word fix.
          r.report === 'exit-code-only'
            ? '  ⚠ no test count could be read — this is exit-code-only evidence (confidence 0.6).\n' +
              '    Add a machine-readable reporter to the verify command (e.g. `--reporter=json`\n' +
              '    for Vitest/Jest, or `--test-reporter=tap` for node:test) to record real counts.'
            : '',
        ]
          .filter((line) => line !== '')
          .join('\n'),
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
    .option(
      '--override <reason>',
      'proceed despite Definition-of-Ready findings, saying why (ADR-0031)',
    )
    .option('--json', 'emit JSON')
    .action(
      async (
        id: string,
        options: { as?: string; override?: string; json?: boolean },
      ): Promise<void> => {
        const result = await advanceWorkItem(root(), id, {
          actor: options.as,
          readinessOverride: options.override,
        });
        emit(result, options.json === true, (r: Awaited<ReturnType<typeof advanceWorkItem>>) =>
          [
            r.moved
              ? `${r.workItemId}: ${r.from} → ${r.to}`
              : [
                  `${r.workItemId}: BLOCKED at "${r.from}"${r.to === null ? '' : ` (wanted "${r.to}")`}`,
                  ...r.refusals.map((reason) => `  ✗ ${reason}`),
                ].join('\n'),
            // Printed on a *successful* move too. A soft gate whose findings only
            // appear when it blocks is a gate that never says anything.
            ...(r.readiness === undefined
              ? []
              : ['  not ready, proceeding anyway:', ...r.readiness.map((line) => `  ⚠ ${line}`)]),
          ].join('\n'),
        );
        if (!result.moved) process.exitCode = 1;
      },
    );

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
    .command('pr')
    .argument('<work-item-id>', 'the work item to open a pull request for')
    .description("render a PR title and body with this item's recorded evidence bundle")
    .option('--json', 'emit JSON')
    .action(async (id: string, options: { json?: boolean }): Promise<void> => {
      const result = await prFor(root(), id);
      emit(result, options.json === true, (r: Awaited<ReturnType<typeof prFor>>) =>
        [
          `# ${r.title}`,
          `branch: ${r.branch}`,
          '',
          r.body,
          '',
          // Stated rather than left for the reader to infer from the table: a
          // body can be perfectly well-formed and describe a gate that fails.
          r.gatePasses
            ? `gate: passes on ${String(r.evidenceCount)} recorded run(s)`
            : `gate: DOES NOT PASS — ${String(r.evidenceCount)} recorded run(s), ${String(r.staleCount)} stale`,
        ].join('\n'),
      );
    });

  program
    .command('queue')
    .description('what can be worked on now, and what is waiting on what')
    .option('--json', 'emit JSON')
    .action(async (options: { json?: boolean }): Promise<void> => {
      const result = await queueFor(root());
      emit(result, options.json === true, (r: Awaited<ReturnType<typeof queueFor>>) => {
        if (r.cycle !== undefined) {
          return [
            `✗ dependency cycle — no wave can be scheduled: ${r.cycle.join(', ')}`,
            '  Break the cycle by removing a `blocked_by` entry on one of these cards.',
          ].join('\n');
        }
        if (r.waves.length === 0) {
          return `Nothing open.${r.completed.length === 0 ? '' : ` ${String(r.completed.length)} item(s) done.`}`;
        }
        const declaresNothing = r.waves.every((wave) =>
          wave.items.every((item) => item.blockedBy.length === 0),
        );
        return [
          ...(declaresNothing
            ? [
                'No work item declares `blocked_by`, so this ordering carries no dependency',
                'information. Add one with `sdlc new … --blocked-by TASK-001`.',
                '',
              ]
            : []),
        ]
          .concat(
            r.waves.flatMap((wave) => [
              `wave ${String(wave.index)}${wave.index === 0 ? '  (ready now)' : '  (waiting on wave ' + String(wave.index - 1) + ')'}`,
              ...wave.items.map(
                (item) =>
                  `  ${item.id.padEnd(12)} ${item.riskLevel.padEnd(7)} ${item.lifecycleState.padEnd(16)} ${item.title}` +
                  (item.claimedBy === null ? '' : `  [claimed by ${item.claimedBy}]`),
              ),
            ]),
          )
          .join('\n');
      });
    });

  program
    .command('review')
    .argument('<work-item-id>', 'the work item being reviewed')
    .description('record that a review happened, with what it found')
    .option('--as <actor>', 'who reviewed it', process.env['USER'] ?? 'local')
    .option('--agent', "record as an agent's review — advisory, cannot satisfy the gate")
    .option('--finding <text>', 'a finding (repeatable)', collect, [])
    .option('--no-findings-because <reason>', 'why a review with no findings is legitimate')
    .option('--json', 'emit JSON')
    .action(
      async (
        id: string,
        options: {
          as?: string;
          agent?: boolean;
          finding?: string[];
          findingsBecause?: string;
          json?: boolean;
        },
      ): Promise<void> => {
        const result = await recordReview(root(), id, {
          actor: options.as ?? 'local',
          actorKind: options.agent === true ? 'agent' : 'human',
          findings: options.finding,
          noFindingsBecause: options.findingsBecause,
        });
        emit(result, options.json === true, (r: Awaited<ReturnType<typeof recordReview>>) =>
          [
            `${r.workItemId}: ${r.summary}`,
            `  reviewer: ${r.reviewer} (${r.actorKind})`,
            `  evidence: #${String(r.evidenceId)}`,
          ].join('\n'),
        );
      },
    );

  program
    .command('claims')
    .argument('<work-item-id>', 'the work item the claims are about')
    .description('verify what an agent asserted against the chunks it cited (ADR-0019)')
    .option(
      '--claim <text>',
      'a claim, as `<chunk-id>[,<chunk-id>]: <assertion>` (repeatable)',
      collect,
      [],
    )
    .option('--json', 'emit JSON')
    .action(async (id: string, options: { claim?: string[]; json?: boolean }): Promise<void> => {
      const claims = (options.claim ?? []).map((raw) => {
        const at = raw.indexOf(':');
        // An unparseable claim becomes an *uncited* claim rather than an error:
        // it still gets verified, and abstains for citing nothing. Rejecting it
        // outright would let a malformed claim disappear from the report.
        if (at === -1) return { claim: raw.trim(), cited_chunk_ids: [] };
        return {
          claim: raw.slice(at + 1).trim(),
          cited_chunk_ids: raw
            .slice(0, at)
            .split(',')
            .map((part) => part.trim())
            .filter((part) => part.length > 0),
        };
      });

      const result = await verifyWorkItemClaims(root(), id, claims);
      emit(result, options.json === true, formatClaims);
      // A gate that reports a problem and exits 0 is a gate nothing downstream
      // can act on.
      if (!result.bundle.ok) process.exitCode = 1;
    });

  const echo = program
    .command('echo')
    .description('restate a requirement and get it approved before planning (ADR-0049)');

  echo
    .command('record')
    .argument('<work-item-id>', 'the work item being restated')
    .requiredOption(
      '--understanding <text>',
      'the restatement, tight — not a re-dump of the prompt',
    )
    .option('--scope <text>', 'something in scope (repeatable)', collect, [])
    .option(
      '--out-of-scope <text>',
      'something deliberately not in scope (repeatable)',
      collect,
      [],
    )
    .option('--question <text>', 'something the agent cannot resolve (repeatable)', collect, [])
    .option('--ambiguity <level>', 'low | medium | high', 'medium')
    .option('--json', 'emit JSON')
    .action(
      async (
        id: string,
        options: {
          understanding: string;
          scope?: string[];
          outOfScope?: string[];
          question?: string[];
          ambiguity?: string;
          json?: boolean;
        },
      ): Promise<void> => {
        const ambiguity = AmbiguitySchema.safeParse(options.ambiguity ?? 'medium');
        if (!ambiguity.success) {
          throw new Error(
            `unknown ambiguity "${String(options.ambiguity)}" — expected low, medium or high`,
          );
        }
        const file = await recordEchoBack(root(), {
          workItemId: id,
          understanding: options.understanding,
          scope: options.scope ?? [],
          outOfScope: options.outOfScope ?? [],
          assumptions: [],
          questions: options.question ?? [],
          ambiguity: ambiguity.data,
        });
        emit(
          { workItemId: id, file },
          options.json === true,
          (r: { workItemId: string; file: string }) =>
            `${r.workItemId}: understanding recorded — a human has to approve it before planning.\n  ${r.file}`,
        );
      },
    );

  echo
    .command('approve')
    .argument('<work-item-id>', 'the work item whose understanding is being approved')
    .option('--as <actor>', 'who is approving', process.env['USER'] ?? 'local')
    .option('--answer <text>', 'an answer, in question order (repeatable)', collect, [])
    .option('--correction <text>', 'what the agent got wrong (repeatable)', collect, [])
    .option('--json', 'emit JSON')
    .action(
      async (
        id: string,
        options: { as?: string; answer?: string[]; correction?: string[]; json?: boolean },
      ): Promise<void> => {
        // Presence is read off the process, never off `--as`: an agent can type
        // any actor string, and did — `--as agent` used to write "decided by:
        // agent (human)" straight into human-loop.md.
        const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
        if (interactive) await confirmAtTerminal(id);

        const result = await approveEchoBack(root(), id, {
          actor: options.as ?? 'local',
          presence: interactive ? 'interactive-tty' : 'unattended',
          decision: (options.correction ?? []).length > 0 ? 'corrected' : 'approved',
          answers: options.answer,
          corrections: options.correction,
        });
        emit(result, options.json === true, (r: Awaited<ReturnType<typeof approveEchoBack>>) =>
          [
            `${r.workItemId}: understanding ${r.verdict.ok ? r.verdict.reason : 'refused'}`,
            `  ${r.qnaPath}`,
            `  ${r.humanLoopPath}`,
          ].join('\n'),
        );
      },
    );

  echo
    .command('show')
    .argument('<work-item-id>', 'the work item to show the restatement for')
    .option('--json', 'emit JSON')
    .action(async (id: string, options: { json?: boolean }): Promise<void> => {
      const record = await readEchoBack(root(), id);
      if (record === null) throw new Error(`${id} has no recorded echo-back`);
      const { renderQna } = await import('@sdlc-on-fire/core');
      emit(record, options.json === true, (r: NonNullable<typeof record>) => renderQna(r));
    });

  program
    .command('comment')
    .argument('<work-item-id>', 'the work item to comment on')
    .argument('<body>', 'the comment text')
    .description('post a typed comment; its effect is computed from type × role, never from text')
    .option(
      '--type <type>',
      'normal | agent-instruction | decision | blocker | bug-report | review | context-reference',
      'normal',
    )
    .option('--role <role>', "the author's role, when the workspace has roles")
    .option('--to <agent>', 'narrow an instruction to one agent or role')
    .option('--json', 'emit JSON')
    .action(
      async (
        id: string,
        body: string,
        options: { type?: string; role?: string; to?: string; json?: boolean },
      ): Promise<void> => {
        const result = await postComment(root(), id, {
          type: options.type ?? 'normal',
          body,
          role: options.role,
          addressedTo: options.to,
        });
        emit(result, options.json === true, (r: typeof result) =>
          [
            `${r.workItemId}: #${String(r.id)} recorded as ${r.type} → ${r.roleEffect}`,
            r.steers
              ? '  This will reach the next context pack — not the run in flight (ADR-0016).'
              : '  This changes nothing about what agents see; the effect says so, not the wording.',
          ].join('\n'),
        );
      },
    );

  program
    .command('directives')
    .argument('<work-item-id>', 'the work item to show pending directives for')
    .description("what typed comments will carry into this item's next context pack")
    .option('--agent <agent>', 'the agent about to run, for addressed_to filtering')
    .option('--json', 'emit JSON')
    .action(async (id: string, options: { agent?: string; json?: boolean }): Promise<void> => {
      const text = await directivesFor(root(), id, { agent: options.agent });
      emit(
        { workItemId: id, directives: text ?? null },
        options.json === true,
        () => text ?? `${id}: no comment carries into the next pack.`,
      );
    });

  program
    .command('docs')
    .description('check documentation freshness against the change window (ADR-0046)')
    .option('--since <ref>', 'git ref to compare against', 'HEAD~1')
    .option('--json', 'emit JSON')
    .action(async (options: { since?: string; json?: boolean }): Promise<void> => {
      const result = await checkDocs(root(), options.since ?? 'HEAD~1');
      emit(result, options.json === true, formatDocsCheck);
      // Advisory findings deliberately do not affect the exit code.
      if (!result.report.ok) process.exitCode = 1;
    });

  program
    .command('initiative')
    .argument('<kind>', INITIATIVE_KINDS.join(' | '))
    .argument('<title>', 'what this initiative is for')
    .description('scaffold a dated plan folder with its decisions, Q&A, verification and UAT')
    .option('--date <yyyy-mm-dd>', 'the date this initiative belongs to', todayIso())
    .option('--json', 'emit JSON')
    .action(
      async (
        kind: string,
        title: string,
        options: { date?: string; json?: boolean },
      ): Promise<void> => {
        if (!(INITIATIVE_KINDS as readonly string[]).includes(kind)) {
          throw new Error(`unknown kind "${kind}" — expected ${INITIATIVE_KINDS.join(', ')}`);
        }
        const result = await createInitiative(root(), {
          kind: kind as InitiativeKind,
          title,
          date: options.date ?? todayIso(),
        });
        emit(result, options.json === true, (r: typeof result) =>
          [`${r.dir}`, ...r.created.map((file) => `  + ${file}`)].join('\n'),
        );
      },
    );

  program
    .command('guide')
    .argument('<path>', 'the user guide to check, relative to the workspace root')
    .description('check a user guide reads plainly and its diagrams are accessible (ADR-0057)')
    .option('--json', 'emit JSON')
    .action(async (file: string, options: { json?: boolean }): Promise<void> => {
      const result = await checkGuide(root(), file);
      emit(result, options.json === true, formatGuideCheck);
      if (!result.ok) process.exitCode = 1;
    });

  program
    .command('doc-health')
    .description('corpus-level documentation problems: orphans, missing indexes, redundancy')
    .option('--json', 'emit JSON')
    .action(async (options: { json?: boolean }): Promise<void> => {
      const result = await docHealth(root());
      emit(result, options.json === true, formatDocHealth);
      // No non-zero exit. Every finding is advisory, and an exit code would
      // make a lexical redundancy guess fail somebody's build.
    });

  program
    .command('score')
    .argument('<work-item-id>', 'the work item to score')
    .description('observed spec-quality score — a trend line, never a gate (P1-OBJ-07)')
    .option('--json', 'emit JSON')
    .action(async (id: string, options: { json?: boolean }): Promise<void> => {
      const result = await scoreWorkItem(root(), id);
      const { formatSpecQuality } = await import('@sdlc-on-fire/evidence');
      emit(result, options.json === true, formatSpecQuality);
      // Deliberately no non-zero exit. An exit code is how an observed number
      // becomes a gate by accident in somebody's CI.
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
                `${item.attestation === 'unsupported' ? '⚠' : item.attestation === 'stale' ? '~' : ' '} ${item.id.padEnd(12)} ${item.lifecycleState.padEnd(16)} ${item.title}`,
                ...(item.concern === undefined ? [] : [`    ↳ ${item.concern}`]),
              ])
              .join('\n'),
      );
    });

  const deps = program
    .command('deps')
    .description('supply-chain checks on this project’s dependencies (P2-SEC-01)');

  deps
    .command('check')
    .description('classify every declared dependency and evaluate the install gate')
    .option('--allow-cleared', 'skip approval when every package clears (not the default)')
    .option('--json', 'emit JSON')
    .action(async (options: { allowCleared?: boolean; json?: boolean }): Promise<void> => {
      const result = await checkDependencies(root(), {
        ...(options.allowCleared === true ? { approveEveryInstall: false } : {}),
      });
      emit(result, options.json === true, (r: Awaited<ReturnType<typeof checkDependencies>>) =>
        formatDepsCheck(r),
      );
      // A blocked install must fail the process, or a script treats "refused"
      // as "fine" and installs anyway.
      if (result.gate.decision === 'blocked') process.exitCode = 1;
    });

  program
    .command('scan')
    .description('scan the workspace for secrets and prompt-injection patterns (P2-SEC-02)')
    .option('--skip-gitleaks', 'run only the built-in scanner')
    .option('--json', 'emit JSON')
    .action(async (options: { skipGitleaks?: boolean; json?: boolean }): Promise<void> => {
      const result = await scanWorkspace(root(), {
        ...(options.skipGitleaks === true ? { skipGitleaks: true } : {}),
      });
      emit(result, options.json === true, (r: Awaited<ReturnType<typeof scanWorkspace>>) =>
        formatScan(r),
      );
      // A blocked scan must fail the process, or CI treats a committed
      // credential as a passing build.
      if (result.gate.decision === 'blocked') process.exitCode = 1;
    });

  program
    .command('detect')
    .description('report every supported source format found in this repo (P2-IMP-02)')
    .option('--json', 'emit JSON')
    .action(async (options: { json?: boolean }): Promise<void> => {
      const result = await detectTools(root());
      emit(result, options.json === true, (r: Awaited<ReturnType<typeof detectTools>>) =>
        formatDetect(r),
      );
    });

  program
    .command('import')
    .description("import an existing tool's specs and plans into this workspace (P2-IMP-07)")
    .option('--from <tool>', 'source tool id; defaults to the highest-confidence detection')
    .option('--dry-run', 'report exactly what would be written, and write nothing')
    .option('--into <folder>', 'subfolder to import into', '_imported')
    .option('--no-preserve-originals', 'skip copying the source tree into .sdlcof/imported/')
    .option('--on-conflict <policy>', 'skip | overwrite | fail', 'fail')
    .option('--report <file>', 'also write the full plan as JSON')
    .option('--json', 'emit JSON')
    .action(
      async (options: {
        from?: string;
        dryRun?: boolean;
        into?: string;
        preserveOriginals?: boolean;
        onConflict?: string;
        report?: string;
        json?: boolean;
      }): Promise<void> => {
        const result = await runImport(root(), {
          from: options.from,
          dryRun: options.dryRun === true,
          into: options.into,
          preserveOriginals: options.preserveOriginals,
          onConflict: options.onConflict as ConflictPolicy | undefined,
        });
        if (options.report !== undefined) {
          await fs.writeFile(options.report, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
        }
        emit(result, options.json === true, (r: Awaited<ReturnType<typeof runImport>>) =>
          formatImport(r),
        );
        // A rolled-back import is a failure, and a zero exit would let a script
        // treat "nothing landed" as success.
        if (!r_committed(result)) process.exitCode = 1;
      },
    );

  const skills = program
    .command('skills')
    .description('the canonical skills and the agent surfaces they compile to (contract 04)');

  skills
    .command('doctor')
    .description('check every canonical skill against every target before anything is written')
    .option('--json', 'emit JSON')
    .action((options: { json?: boolean }): void => {
      const report = doctorSkills();
      emit(report, options.json === true, (r: ReturnType<typeof doctorSkills>) => formatDoctor(r));
      // An error-severity finding means a compile would drop something. Exiting
      // non-zero is what lets this sit in a pre-commit hook or CI at all.
      if (!report.ok) process.exitCode = 1;
    });

  skills
    .command('compile')
    .description('compile the canonical skills to the Claude Code surface')
    .option('--dry-run', 'report what would be written without writing it')
    .option('--json', 'emit JSON')
    .action(async (options: { dryRun?: boolean; json?: boolean }): Promise<void> => {
      const result = await compileSkills(root(), { dryRun: options.dryRun === true });
      emit(result, options.json === true, (r: Awaited<ReturnType<typeof compileSkills>>) =>
        formatCompile(r, options.dryRun === true),
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
          ...(r.undeclared.length === 0
            ? []
            : [
                '',
                `⚠ ${String(r.undeclared.length)} routed model(s) have no declared licensing/privacy/retention posture:`,
                ...r.undeclared.map((model) => `    ${model}`),
                '  See docs/.plan/model-posture-checklist.md, then set `agents.posture.<model-id>`.',
              ]),
        ].join('\n'),
      );
      if (result.unroutable.length > 0) process.exitCode = 1;
    });

  program
    .command('audit')
    .description('run a dependency audit and record it as advisory (non-gating) evidence')
    .option('--command <cmd>', 'audit command to run', 'pnpm audit --json')
    .option('--json', 'emit JSON')
    .action(async (options: { command?: string; json?: boolean }): Promise<void> => {
      const result = await auditDependencies(root(), { command: options.command });
      emit(result, options.json === true, (r: Awaited<ReturnType<typeof auditDependencies>>) =>
        [
          r.summary,
          `  evidence: #${String(r.evidenceId)}`,
          ...r.audit.advisories
            .slice(0, 10)
            .map(
              (advisory) =>
                `  ${advisory.severity.padEnd(9)} ${advisory.module}${advisory.dev_only ? ' (dev only)' : ''} — ${advisory.title}`,
            ),
          r.audit.advisories.length > 10
            ? `  … and ${String(r.audit.advisories.length - 10)} more`
            : '',
        ]
          .filter((line) => line !== '')
          .join('\n'),
      );
      // Exit 0 whatever it found. A non-zero exit on findings would make this
      // blocking through the back door, in CI if nowhere else.
    });

  const memory = program.command('memory').description('the project typed memory (ADR-0023)');

  memory
    .command('add')
    .argument('<title>', 'the subject this claim is about')
    .argument('<body>', 'the claim itself')
    .description('record a memory entry, superseding any earlier claim about the same subject')
    .option('--type <type>', 'episodic | semantic | procedural | prospective', 'semantic')
    .option(
      '--source <source>',
      'user-authored | agent-inferred | retrospective-synthesized',
      'user-authored',
    )
    .option('--by <who>', 'agent or skill name plus run id', process.env['USER'] ?? 'local')
    .option('--work-item <id>', 'scope it to a work item')
    .option('--importance <n>', 'salience at write, 0..1')
    .option('--valid-from <iso>', 'when this became true, if not now')
    .option('--json', 'emit JSON')
    .action(
      async (
        title: string,
        body: string,
        options: {
          type?: string;
          source?: string;
          by?: string;
          workItem?: string;
          importance?: string;
          validFrom?: string;
          json?: boolean;
        },
      ): Promise<void> => {
        const result = await recordMemoryEntry(root(), {
          type: options.type ?? 'semantic',
          title,
          body,
          source: options.source ?? 'user-authored',
          writtenBy: options.by ?? 'local',
          workItemId: options.workItem,
          importance: options.importance === undefined ? undefined : Number(options.importance),
          validFrom: options.validFrom,
        });
        emit(result, options.json === true, (r: typeof result) =>
          r.recorded
            ? `recorded #${String(r.entry?.id ?? 0)}${r.entry?.conflict_status === 'contested' ? ' — CONTESTED: an earlier claim about this subject cannot be ordered against it, so neither wins' : ''}`
            : `not recorded — ${r.reason ?? ''}`,
        );
      },
    );

  memory
    .command('list')
    .description('what is currently believed, most salient first')
    .option('--type <type>', 'filter by memory type')
    .option('--work-item <id>', 'filter to one work item')
    .option('--json', 'emit JSON')
    .action(
      async (options: { type?: string; workItem?: string; json?: boolean }): Promise<void> => {
        const result = await listMemory(root(), {
          type: options.type,
          workItemId: options.workItem,
        });
        emit(result, options.json === true, (r: typeof result) =>
          r.entries.length === 0
            ? 'Nothing remembered yet.'
            : r.entries
                .map(
                  (entry) =>
                    `${entry.score.toFixed(2)}  ${entry.type.padEnd(11)} ${entry.title}\n` +
                    `        ${entry.body}\n` +
                    `        ${entry.source_type} by ${entry.written_by}` +
                    (entry.conflict_status === 'contested' ? '  [CONTESTED]' : ''),
                )
                .join('\n'),
        );
      },
    );

  memory
    .command('history')
    .argument('<title>', 'the subject to trace')
    .description('every claim ever made about a subject, including retracted ones')
    .option('--json', 'emit JSON')
    .action(async (title: string, options: { json?: boolean }): Promise<void> => {
      const result = await memoryHistoryFor(root(), title);
      emit({ title, entries: result }, options.json === true, () =>
        result.length === 0
          ? `Nothing recorded about "${title}".`
          : result
              .map(
                (entry) =>
                  `${entry.valid_from} → ${entry.valid_to ?? 'now'}  [${entry.conflict_status}]\n` +
                  `        ${entry.body}\n` +
                  `        ${entry.source_type} by ${entry.written_by}`,
              )
              .join('\n'),
      );
    });

  program
    .command('quality')
    .argument('[path]', 'directory to scan (defaults to the workspace root)')
    .description('doc-comment presence on exported API, plus comment-bloat candidates')
    .option('--json', 'emit JSON')
    .action(async (target: string | undefined, options: { json?: boolean }): Promise<void> => {
      const result = await scanQuality(root(), target);
      emit(result, options.json === true, (r: Awaited<ReturnType<typeof scanQuality>>) =>
        [
          `${r.scanned}: ${String(r.documented)}/${String(r.exported)} exported symbols documented across ${String(r.files)} file(s)`,
          ...r.undocumented
            .slice(0, 20)
            .map((finding) => `  ✗ ${finding.file}:${String(finding.line)} ${finding.symbol}`),
          r.undocumented.length > 20 ? `  … and ${String(r.undocumented.length - 20)} more` : '',
          // Kept below and labelled: a heuristic printed alongside a
          // deterministic failure acquires authority it has not earned.
          r.advisory.length === 0
            ? ''
            : `\nadvisory (never blocks): ${String(r.advisory.length)} comment block(s) long enough that the rationale belongs in an ADR`,
        ]
          .filter((line) => line !== '')
          .join('\n'),
      );
      if (!result.ok) process.exitCode = 1;
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
              '',
              'required evidence for this project:',
              ...r.requiredChecks.map((entry) => `  ${entry.kind.padEnd(16)} ${entry.because}`),
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
