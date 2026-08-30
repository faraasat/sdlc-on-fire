// No shebang here: tsup injects one via `banner` (tsup.config.ts). Declaring it
// in the source too produces a duplicate on line 2 of the bundle, which is a
// syntax error — and one that no unit test can see, because tests import the
// module rather than executing the built binary.
import { existsSync, realpathSync } from 'node:fs';
import { formatViews, listViews } from './views.js';
import { exitCodeFor, renderSyncReport, resolveToken, runTrackerSyncCommand } from './tracker.js';
import { formatExport, runExport } from './export.js';
import { archiveChange, checkSpecs, formatSpecCheck, newChange, newSpec } from './spec.js';
import { formatMap, runMap } from './map.js';
import { formatVisibility, readVisibility } from './visibility.js';
import { docVisibility, formatDocVisibility, formatLlmsTxt, llmsTxt } from './docs-check.js';
import { Command } from 'commander';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { agentManagerPackage } from '@sdlc-on-fire/agent-manager';
import { daemonPackage } from '@sdlc-on-fire/daemon';
import { dbPackage } from '@sdlc-on-fire/db';
import {
  corePackage,
  formatWorkItemId,
  kanbanColumnForStage,
  APPETITES,
  AppetiteSchema,
  formatCallVerdict,
  formatProposalVerdict,
  formatRecommendations,
  PRESETS,
  PresetSchema,
  REFRESH_CADENCES,
  resolveRequiredStages,
  resolveWorkspaceLayout,
  WORK_ITEM_ID_PREFIX,
  type PackageInfo,
  type Preset,
  type RefreshCadence,
  AmbiguitySchema,
  PERMISSION_KEYS,
  ROLE_KEYS,
  type RoleKey,
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
  openWorkspaceDatabase,
  claimWorkItem,
  captureItem,
  triageItem,
  showConfig,
  describeAgents,
  status,
  treeContext,
  type InstructionsResult,
} from './commands.js';
import { discoverPlugins, formatPlugins, projectRootFromArgv, registerPlugins } from './plugins.js';
import { serve } from './serve.js';
import {
  agentRunReport,
  blockedReport,
  formatAgentRuns,
  formatBlocked,
  formatGovernance,
  governanceReport,
  doraFromWorkspace,
  flowReport,
  formatDora,
  formatFlow,
  formatHeldOut,
  heldOutReport,
} from './metrics.js';
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
import { checkRisk, formatRisk } from './risk.js';
import { recordRisks } from './risk-record-store.js';
import { dbDown, dbUp, formatDbDown, formatDbUp } from './db-lifecycle.js';
import { formatWorkspaceDoctor, workspaceDoctor } from './doctor.js';
import { formatRun, runWorkItem } from './run.js';
import { formatRetrieval, retrievalReport } from './retrieval-eval-run.js';
import { checkGuard, formatGuardCheck } from './guard.js';
import { addIntoContainer, formatAdd } from './add.js';
import { formatReopen, reopenGates } from './reopen.js';
import { formatRollback, rollbackWorkItem, type RollbackResult } from './rollback.js';
import { ciEvidence, formatCiEvidence, type CiEvidenceResult } from './ci-evidence.js';
import { backupWorkspace, formatBackup, type BackupResult } from './backup.js';
import { formatRuns, runHistory, type RunHistory } from './runs.js';
import { formatTiers, reportTiers } from './tiers.js';
import {
  checkResolution,
  declarationsFor,
  defaultGit as conflictGit,
  formatCheck,
  formatListing,
  listConflicts,
  originalConflict,
} from './conflicts.js';
import { checkLicenses, formatLicenses } from './licenses.js';
import { watchDependencies, formatWatch } from './watch.js';
import {
  checkThreatModels,
  formatThreatCheck,
  scaffoldThreatModel,
  THREAT_MODEL_DIR,
} from './threat.js';
import { formatImport, runImport, type ConflictPolicy } from './import.js';
import { compileSkills, doctorSkills, formatCompile, formatDoctor } from './skills.js';
import { formatNewResearch, formatResearchScan, newResearch, scanResearch } from './research.js';
import { checkE2e, formatE2eCheck, formatE2eSeal, sealE2eEvidence } from './e2e.js';
import {
  checkAccess,
  formatAccessCheck,
  formatGrants,
  formatPolicy,
  grantRole,
  listGrants,
  showPolicy,
  whoami,
} from './access.js';
import {
  approveGate,
  checkQuorum,
  formatGates,
  formatQuorumCheck,
  listGates,
  revokeApproval,
  simulatePolicyChange,
} from './gates.js';
import { formatSimulation } from '@sdlc-on-fire/evidence';
import { addHeldOut, criteriaStatus, formatCriteria } from './criteria.js';
import { deriveRoles, formatRoles } from './roles.js';
import { checkPilot, formatPilotCheck, writePilotTemplate } from './pilot.js';
import {
  checkMcpCall,
  formatMcpList,
  listMcpServers,
  setMcpConsent,
  suggestMcpServers,
} from './mcp.js';
import {
  approveImprovement,
  formatMining,
  formatReview,
  mineImprovements,
  reviewImprovements,
} from './improve.js';
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

/** Whether `init` actually finished, treating a merely-held database as fine. */
function r_ready(result: Awaited<ReturnType<typeof init>>): boolean {
  return result.database.ready || result.database.held === true;
}

/**
 * Whether this invocation asked for machine-readable output.
 *
 * Read from argv rather than from a parsed option, because the failures that
 * matter most happen *before* parsing finishes — an unknown command, a missing
 * required option — and those are exactly the ones an agent currently receives
 * as prose.
 */
function wantsJson(argv: readonly string[]): boolean {
  return argv.includes('--json');
}

/**
 * The failure half of the `--json` contract (P6-SURFACE-01).
 *
 * `--json` used to emit a parseable document on success and **zero bytes on
 * stdout** on failure, with prose on stderr. An agent that asked for JSON got a
 * parse error and no machine-readable reason — and this product's entire
 * positioning is a pipeline driven by coding agents, so the failure path is
 * where structure matters most and was precisely where it was absent.
 *
 * The OpenSpec code study told us to enforce this **structurally, with a shared
 * helper, rather than by per-command discipline**. Ninety commands accept
 * `--json`; per-command discipline across ninety call sites is a promise, not a
 * mechanism. This is the mechanism: one function, one choke point, and a test
 * that fails if a command bypasses it.
 *
 * Success payloads are deliberately *not* re-shaped into an envelope. That would
 * be the fuller form of the study's advice and a breaking change across every
 * `--json` consumer; the defect being fixed is the absence of a failure
 * document, and an agent distinguishes the two by the presence of `error`.
 */
export function renderJsonFailure(error: unknown): string {
  const base =
    error instanceof Error
      ? { name: error.name, message: error.message }
      : { name: 'Error', message: String(error) };
  // `code` is carried when a domain error supplies one, because "which failure
  // was it" is the question an agent branches on, and matching on a message is
  // how a caller ends up broken by a wording change.
  const code = (error as { code?: unknown })?.code;
  return `${JSON.stringify(
    {
      error: {
        ...base,
        ...(typeof code === 'string' || typeof code === 'number' ? { code } : {}),
      },
    },
    null,
    2,
  )}\n`;
}

/**
 * Report a failure **once**, in whichever form was asked for.
 *
 * The latch is load-bearing and was earned: commander's `exitOverride` rethrows
 * so the process still stops, the rethrown error then reaches the top-level
 * catch, and both call this. Without the latch stdout carried *two* JSON
 * documents — which is precisely the "always exactly one JSON document" rule
 * this function exists to keep, broken by the function keeping it.
 */
let reported = false;
function reportFailure(error: unknown, argv: readonly string[]): void {
  if (reported) return;
  reported = true;
  if (wantsJson(argv)) {
    process.stdout.write(renderJsonFailure(error));
  } else {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  }
  process.exitCode = 1;
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
    .option('--minimal', 'operating essentials only — the default on a repo that already has docs')
    .option('--full', 'the complete document set, even on a repo that has its own')
    .option('--json', 'emit JSON')
    .action(async (options: { minimal?: boolean; full?: boolean; json?: boolean }) => {
      if (options.minimal === true && options.full === true) {
        process.stderr.write('--minimal and --full ask for opposite things; pass one\n');
        process.exitCode = 2;
        return;
      }
      const result = await init(root(), {
        ...(options.minimal === true ? { scaffold: 'minimal' as const } : {}),
        ...(options.full === true ? { scaffold: 'full' as const } : {}),
      });
      emit(result, options.json === true, (r: Awaited<ReturnType<typeof init>>) =>
        [
          r.alreadyInitialised ? 'Workspace already initialised.' : 'Workspace initialised.',
          `  root:    ${r.root}`,
          `  created: ${r.created.length} file(s)`,
          `  skipped: ${r.skipped.length} existing file(s)`,
          r.initialisedGit
            ? '  git:     initialised a repository (content in git is how this tool stores work)'
            : '',
          r.database.ready
            ? '  db:      PGlite ready'
            : r.database.held === true
              ? `  db:      held by another process — this is fine. ${r.database.detail}`
              : `  db:      ⚠ ${r.database.detail}`,
        ]
          .filter((line) => line !== '')
          .join('\n'),
      );
      // A database that genuinely failed to come up is a failed init, however
      // valid the scaffold on disk is. Exiting 0 here let `sdlc init && …`
      // sail straight past a workspace with no mirror — found by pointing the
      // published package at real repositories, 2026-08-23. A database merely
      // *held* by another process is the ordinary case and stays exit 0.
      if (!r_ready(result)) process.exitCode = 1;
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
    .command('run')
    .argument('<work-item-id>', 'the work item to run the current stage of')
    .description("dispatch this item's stage skill to an agent, recording the run")
    .option('--dry-run', 'assemble and persist the pack, then stop before dispatching')
    .option('--json', 'emit JSON')
    .action(async (id: string, options: { dryRun?: boolean; json?: boolean }): Promise<void> => {
      const result = await runWorkItem(root(), id, { dryRun: options.dryRun === true });
      emit(result, options.json === true, formatRun);
    });

  program
    .command('doctor')
    .description('diagnose this workspace: config, content, git, database, runtime')
    .option('--json', 'emit JSON')
    .action(async (options: { json?: boolean }): Promise<void> => {
      const report = await workspaceDoctor(root());
      emit(report, options.json === true, formatWorkspaceDoctor);
      // A failing diagnosis exits non-zero so a setup script can branch on it.
      // Exiting 0 while printing "3 checks failed" is the shape of gate that
      // gets wrapped in `|| true` and then never read again.
      if (!report.healthy) process.exitCode = 1;
    });

  program
    .command('db:up')
    .description('make the workspace database reachable and migrated')
    .option('--json', 'emit JSON')
    .action(async (options: { json?: boolean }): Promise<void> => {
      const result = await dbUp(root());
      emit(result, options.json === true, formatDbUp);
    });

  program
    .command('db:down')
    .description("release this workspace's hold on its database")
    .option('--json', 'emit JSON')
    .action(async (options: { json?: boolean }): Promise<void> => {
      const result = await dbDown(root());
      emit(result, options.json === true, formatDbDown);
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
    .command('tracker:sync')
    .description('two-way sync between this workspace and a GitHub Issues repository')
    .requiredOption('--repo <owner/repo>', 'the GitHub repository to sync with')
    .option('--since <iso>', 'only consider remote items updated after this ISO timestamp')
    .option('--policy <policy>', 'refuse | prefer-local | prefer-remote (default: refuse)')
    .option('--dry-run', 'decide everything, write nothing')
    .option('--json', 'emit JSON')
    .action(
      async (options: {
        repo: string;
        since?: string;
        policy?: string;
        dryRun?: boolean;
        json?: boolean;
      }): Promise<void> => {
        const policy = options.policy ?? 'refuse';
        if (policy !== 'refuse' && policy !== 'prefer-local' && policy !== 'prefer-remote') {
          // Rejected up front rather than defaulted. Silently falling back to
          // `refuse` on a typo'd `--policy prefer-loc` would look like the sync
          // simply found conflicts, and the operator would go hunting for a
          // divergence that does not exist.
          throw new Error(
            `unknown --policy "${policy}". Use refuse, prefer-local, or prefer-remote.`,
          );
        }
        const token = await resolveToken();
        const { items } = await listWorkItems(root());
        const { db } = await openWorkspaceDatabase(root());
        try {
          const report = await runTrackerSyncCommand({
            root: root(),
            repo: options.repo,
            token,
            db,
            locals: items.map((item) => ({
              id: item.id,
              title: item.title,
              body: '',
              closed: item.lifecycleState === 'done',
            })),
            ...(options.since === undefined ? {} : { since: options.since }),
            policy,
            dryRun: options.dryRun === true,
          });
          emit(report, options.json === true, renderSyncReport);
          process.exitCode = exitCodeFor(report);
        } finally {
          await db.close();
        }
      },
    );

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
    .command('add')
    .argument('<kind>', 'epic | story | feature | bug | task')
    .argument('<title...>', 'what the new item is')
    .requiredOption('--into <container-id>', 'the epic or sprint to insert into')
    .option('--after <id>', 'place after this sibling (an ordering hint; nothing is renumbered)')
    .option('--why <reason>', 'why this could not wait for the next planning pass')
    .option('--work-type <type>', 'feature | bug | task | migrate | refactor | …', 'feature')
    .option('--owns <path...>', 'files the new item expects to own')
    .description('hard insertion — propose new work into live scope, pending rescope approval')
    .option('--json', 'emit JSON')
    .action(
      async (
        kind: string,
        title: string[],
        options: {
          into: string;
          after?: string;
          why?: string;
          workType?: string;
          owns?: string[];
          json?: boolean;
        },
      ): Promise<void> => {
        const result = await addIntoContainer(root(), {
          kind,
          title: title.join(' '),
          into: options.into,
          ...(options.after === undefined ? {} : { after: options.after }),
          ...(options.why === undefined ? {} : { why: options.why }),
          ...(options.workType === undefined ? {} : { workType: options.workType }),
          ...(options.owns === undefined ? {} : { ownedPaths: options.owns }),
        });
        emit(result, options.json === true, formatAdd);
      },
    );

  program
    .command('tiers')
    .description('which test tiers this repository has, and which the preset requires')
    .option('--preset <preset>', 'lite | standard | strict', 'standard')
    .option('--json', 'emit JSON')
    .action(async (options: { preset?: string; json?: boolean }): Promise<void> => {
      const result = await reportTiers(root(), options.preset ?? 'standard');
      emit(result, options.json === true, formatTiers);
      if (!result.report.satisfied) process.exitCode = 1;
    });

  program
    .command('conflicts')
    .description('lay out both sides of every merge conflict, or check a resolution')
    .option('--check', 'review resolutions instead of listing conflicts')
    .option(
      '--why <hunk=rationale...>',
      'why a side was discarded, e.g. --why 0="superseded by the retry policy"',
      [],
    )
    .option('--claims <path>', "the resolve-conflict skill's JSON output, for per-hunk claims")
    .option('--passed', 'checks were re-run against the resolved tree and passed')
    .option('--failed', 'checks were re-run against the resolved tree and failed')
    .option('--json', 'emit JSON')
    .action(
      async (options: {
        check?: boolean;
        why?: string[];
        claims?: string;
        passed?: boolean;
        failed?: boolean;
        json?: boolean;
      }): Promise<void> => {
        const workspace = root();
        const git = conflictGit(workspace);

        if (options.check !== true) {
          emit(await listConflicts(workspace, git), options.json === true, formatListing);
          return;
        }

        const fromFlags = (options.why ?? []).map((entry) => {
          const [hunk, ...rest] = entry.split('=');
          return { hunk: Number.parseInt(hunk ?? '0', 10), rationale: rest.join('=') };
        });

        // The `resolve-conflict` skill's output, when it produced the
        // resolution. It carries the `kind` each hunk was claimed to be, which
        // the review compares against the file — the disposer for the skill's
        // account of itself (P2-SKILL-07).
        const claims =
          options.claims === undefined
            ? null
            : (JSON.parse(await fs.readFile(options.claims, 'utf8')) as unknown);

        const tree = await treeContext(workspace);
        const head = {
          git_sha: tree.headSha,
          ...(tree.dirtyTreeHash === undefined ? {} : { dirty_tree_hash: tree.dirtyTreeHash }),
        };
        // `--passed` reports a run this command did not observe, so it is a
        // claim rather than evidence — and absent either flag there is no
        // evidence at all, which is the refusal. Binding this to a real
        // EvidenceEnvelope belongs to the gate runner, not a second pipeline.
        const evidence =
          options.passed === true || options.failed === true
            ? { ...head, passed: options.passed === true }
            : null;

        const scratch = path.join(workspace, '.sdlcof', 'cache', 'merge');
        const checked: ReturnType<typeof checkResolution>[] = [];
        for (const file of (await listConflicts(workspace, git)).files) {
          const original = await originalConflict(git, file.path, scratch);
          if (original === null) continue;
          const resolved = await fs.readFile(path.join(workspace, file.path), 'utf8');
          const declared = [
            ...fromFlags,
            ...(claims === null ? [] : declarationsFor(claims, file.path)),
          ];
          checked.push(checkResolution(file.path, original, resolved, declared, evidence, head));
        }

        if (checked.length === 0) {
          emit([], options.json === true, () => 'No unmerged files to check.');
          return;
        }

        emit(checked, options.json === true, (all: typeof checked) =>
          all.map(formatCheck).join('\n\n'),
        );
        if (checked.some((result) => !result.accepted)) process.exitCode = 1;
      },
    );

  program
    // Not `reopen` — that verb is taken by claim retraction below, and the two
    // are different acts: that one withdraws a terminal claim its own evidence
    // never supported, this one re-arms gates an approved insertion invalidated.
    .command('reopen-gates')
    .argument('<insertion-id>', 'the approved insertion authorising this, e.g. INSERT-014')
    .requiredOption('--requires <ids...>', 'gate requirements to consider')
    .option('--changed <paths...>', 'files the insertion changed', [])
    .option(
      '--covers <requirement=prefix...>',
      'declared coverage, e.g. unit-tests=src/ (undeclared requirements always re-open)',
      [],
    )
    .option('--work-type <type>', 'feature | bug | task | migrate | refactor | …', 'feature')
    .option('--apply', 'append the audit section to the insertion record')
    .description('selectively re-open gates a hard insertion invalidated')
    .option('--json', 'emit JSON')
    .action(
      async (
        insertionId: string,
        options: {
          requires: string[];
          changed?: string[];
          covers?: string[];
          workType?: string;
          apply?: boolean;
          json?: boolean;
        },
      ): Promise<void> => {
        const coverage = (options.covers ?? []).map((entry) => {
          const [requirementId, ...rest] = entry.split('=');
          return { requirementId: requirementId ?? entry, paths: rest.join('=').split(',') };
        });
        const result = await reopenGates(root(), {
          insertionId,
          requirements: options.requires,
          changed: options.changed ?? [],
          coverage,
          ...(options.workType === undefined ? {} : { workType: options.workType }),
          ...(options.apply === undefined ? {} : { apply: options.apply }),
        });
        emit(result, options.json === true, formatReopen);
      },
    );

  program
    .command('triage')
    .argument('<capture-id>', 'the capture to promote, e.g. CAP-001')
    // `--type` is an accepted alias, not a second spelling to remember.
    //
    // The on-disk frontmatter field is `type` (contract 06 §3.3), so somebody
    // who has read a card reaches for `--type` and gets `unknown option`. Found
    // on the hono pilot, by exactly that route. The fix is an alias rather than
    // a rename: `--as` reads better at a command line ("triage this as a bug"),
    // and renaming the field to match would break every card already written.
    // Both optional at the parser, with the "exactly one" rule enforced below.
    // `requiredOption('--as')` would reject `--type` on its own, which is the
    // whole failure this alias exists to remove.
    .option('--as <kind>', 'epic | story | feature | bug | task')
    .option('--type <kind>', 'alias for --as, matching the on-disk frontmatter field')
    .option('--preset <preset>', 'lite | standard | strict', 'standard')
    .description('turn a capture into a real work item')
    .option('--json', 'emit JSON')
    .action(
      async (
        capturedId: string,
        options: { as?: string; type?: string; preset?: string; json?: boolean },
      ): Promise<void> => {
        const kind = options.as ?? options.type;
        if (kind === undefined) {
          process.stderr.write(
            'triage needs a kind: --as <epic|story|feature|bug|task> (--type is accepted too)\n',
          );
          process.exitCode = 2;
          return;
        }
        if (options.as !== undefined && options.type !== undefined && options.as !== options.type) {
          // Two spellings of one argument disagreeing is not a preference to
          // resolve — picking either silently would do something the user did
          // not ask for.
          process.stderr.write(
            `--as ${options.as} and --type ${options.type} disagree; pass one\n`,
          );
          process.exitCode = 2;
          return;
        }
        const result = await triageItem(root(), capturedId, kind, options.preset ?? 'standard');
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
    .command('runs')
    .description('the run history — every agent run, newest first, joined to its work item')
    .option('--work-item <id>', 'only runs for this work item')
    .option('--status <status>', 'only runs that ended this way (pass, fail, error, running)')
    .option('--limit <n>', 'how many to show', '20')
    .option('--json', 'emit JSON')
    .action(
      async (options: {
        workItem?: string;
        status?: string;
        limit?: string;
        json?: boolean;
      }): Promise<void> => {
        const parsed = Number.parseInt(options.limit ?? '20', 10);
        const result = await runHistory(root(), {
          workItemId: options.workItem,
          status: options.status,
          ...(Number.isNaN(parsed) ? {} : { limit: parsed }),
        });
        emit(result, options.json === true, (r: RunHistory) => formatRuns(r));
      },
    );

  program
    .command('backup')
    .description('archive the workspace content that cannot be rebuilt from the database')
    .option('--out <dir>', 'where to write the archive (default: <state-dir>/backups)')
    .option(
      '--include-mirror',
      'include the database too — reconstructable with db:rebuild, so off by default',
    )
    .option('--json', 'emit JSON')
    .action(
      async (options: { out?: string; includeMirror?: boolean; json?: boolean }): Promise<void> => {
        const result = await backupWorkspace(root(), {
          out: options.out,
          includeMirror: options.includeMirror,
        });
        emit(result, options.json === true, (r: BackupResult) => formatBackup(r));
      },
    );

  program
    .command('ci-evidence')
    .description('admit a CI check run as gate evidence — fetched from the provider, not handed in')
    .requiredOption('--repo <owner/repo>', 'the GitHub repository the checks live in')
    .requiredOption('--ref <sha-or-branch>', 'the ref whose check runs to read')
    .requiredOption('--check <name>', 'which check run — named, never guessed from its title')
    .option('--apply', 'record the evidence; without this it reports what it would write')
    .option('--json', 'emit JSON')
    .action(
      async (options: {
        repo: string;
        ref: string;
        check: string;
        apply?: boolean;
        json?: boolean;
      }): Promise<void> => {
        const result = await ciEvidence(root(), {
          repo: options.repo,
          ref: options.ref,
          check: options.check,
          apply: options.apply,
        });
        emit(result, options.json === true, (r: CiEvidenceResult) => formatCiEvidence(r));
        // A refusal is an exit 1: "no evidence was written" has to be
        // distinguishable from "evidence was written and it was green" by
        // something a script can read.
        if (!result.admission.admitted) process.exitCode = 1;
      },
    );

  program
    .command('rollback')
    .argument('<work-item-id>', 'the work item to abandon, e.g. TASK-001')
    .description("abandon a work item's branch, worktree and claim — keeping every record of it")
    .option('--as <actor>', 'who is rolling it back — must hold the claim')
    .option('--base <ref>', 'the branch this work was meant to land on', 'main')
    .option('--force', 'discard uncommitted changes in the worktree')
    .option('--apply', 'actually do it; without this the plan is printed and nothing is touched')
    .option('--json', 'emit JSON')
    .action(
      async (
        id: string,
        options: { as?: string; base?: string; force?: boolean; apply?: boolean; json?: boolean },
      ): Promise<void> => {
        const result = await rollbackWorkItem(root(), id, {
          actor: options.as,
          base: options.base,
          force: options.force,
          apply: options.apply,
        });
        emit(result, options.json === true, (r: RollbackResult) => formatRollback(r));
        if (!result.plan.safe) process.exitCode = 1;
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
      'normal | agent-instruction | decision | blocker | bug-report | review | context-reference | ux-acceptance | rescope',
      'normal',
    )
    .option('--role <role>', "the author's role — must be one you actually hold (ADR-0012)")
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
            `${r.workItemId}: #${String(r.id)} recorded as ${r.type}` +
              `${r.authorRole === null ? '' : ` by a ${r.authorRole}`} → ${r.roleEffect}`,
            r.steers
              ? '  This will reach the next context pack — not the run in flight (ADR-0016).'
              : '  This changes nothing about what agents see; the effect says so, not the wording.',
            // Named, because a comment that quietly created a card somewhere
            // else is a side effect the author cannot see and did not ask for.
            ...(r.spawnedCapture === undefined
              ? []
              : [
                  `  Captured as ${r.spawnedCapture} — \`sdlc triage ${r.spawnedCapture} --as bug\` when someone has looked.`,
                ]),
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
    .command('visibility')
    .description('read a recorded AI-search visibility corpus (offline; makes no calls)')
    .requiredOption('--subject <name>', 'the project name to look for in answers')
    .requiredOption('--host <domain>', 'the domain that counts as your own')
    .option('--json', 'emit JSON')
    .action(async (options: { subject: string; host: string; json?: boolean }): Promise<void> => {
      const result = await readVisibility(root(), options.subject, options.host);
      emit(result, options.json === true, formatVisibility);
      // A corpus whose design cannot support its own claim fails the command.
      // Reporting the numbers under a warning would let somebody quote them.
      if (result.problems.length > 0) process.exitCode = 1;
    });

  program
    .command('map')
    .description('propose a spec tree from an existing codebase (brownfield on-ramp)')
    .option('--write', 'create the inferred stubs under docs/specs/')
    .option('--all', 'also write stubs for low-confidence (grab-bag) domains')
    .option('--max <n>', 'cap the number of proposed domains', (v) => Number(v))
    .option('--json', 'emit JSON')
    .action(
      async (options: {
        write?: boolean;
        all?: boolean;
        max?: number;
        json?: boolean;
      }): Promise<void> => {
        const result = await runMap(root(), {
          ...(options.write === true ? { write: true } : {}),
          ...(options.all === true ? { includeUnlikely: true } : {}),
          ...(options.max === undefined || Number.isNaN(options.max)
            ? {}
            : { maxDomains: options.max }),
        });
        emit(result, options.json === true, formatMap);
      },
    );

  const spec = program.command('spec').description('native brownfield spec authoring');

  spec
    .command('new')
    .argument('<domain>', 'the domain this spec covers')
    .description('scaffold docs/specs/<domain>/spec.md')
    .action(async (domain: string): Promise<void> => {
      const result = await newSpec(root(), domain);
      process.stdout.write(
        result.created
          ? `Created ${result.path}\n`
          : `${result.path} already exists — left alone\n`,
      );
      if (!result.created) process.exitCode = 1;
    });

  spec
    .command('check')
    .description('validate every spec and open change')
    .option('--json', 'emit JSON')
    .action(async (options: { json?: boolean }): Promise<void> => {
      const result = await checkSpecs(root());
      emit(result, options.json === true, formatSpecCheck);
      // Refusals fail; advice does not. A validator that failed on style is one
      // people switch off, taking the two real refusals with it.
      if (!result.ok) process.exitCode = 1;
    });

  const change = program.command('change').description('spec deltas against the current truth');

  change
    .command('new')
    .argument('<id>', 'the change id')
    .description('scaffold docs/changes/<id>/proposal.md')
    .action(async (id: string): Promise<void> => {
      const result = await newChange(root(), id);
      process.stdout.write(
        result.created
          ? `Created ${result.path}\n`
          : `${result.path} already exists — left alone\n`,
      );
      if (!result.created) process.exitCode = 1;
    });

  change
    .command('archive')
    .argument('<id>', 'the change id')
    .description('land a change: move it under changes/archive/')
    .action(async (id: string): Promise<void> => {
      const result = await archiveChange(root(), id);
      if (result.moved) process.stdout.write(`Archived ${result.from} -> ${result.to}\n`);
      else {
        process.stderr.write(`Not archived: ${result.because ?? 'unknown reason'}\n`);
        process.exitCode = 1;
      }
    });

  program
    .command('export')
    .description("write a snapshot of this workspace in another tool's format")
    .requiredOption('--to <tool>', 'target format')
    .option('--out <dir>', 'output directory')
    .option('--dry-run', 'report what would be written, and what would be lost')
    .option('--json', 'emit JSON')
    .action(
      async (options: {
        to: string;
        out?: string;
        dryRun?: boolean;
        json?: boolean;
      }): Promise<void> => {
        try {
          const result = await runExport(root(), options.to, {
            ...(options.out === undefined ? {} : { outDir: options.out }),
            ...(options.dryRun === true ? { dryRun: true } : {}),
          });
          emit(result, options.json === true, formatExport);
          // Non-zero when an exporter broke its own fidelity claim. This is the
          // one place a self-report could slip through, so it fails loudly.
          if (result.violations.length > 0) process.exitCode = 1;
        } catch (cause) {
          process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
          process.exitCode = 2;
        }
      },
    );

  program
    .command('llms-txt')
    .description('compile docs/ into a well-known llms.txt index')
    .option('--check', 'do not write; fail if the committed file is out of date')
    .option('--json', 'emit JSON')
    .action(async (options: { check?: boolean; json?: boolean }): Promise<void> => {
      const result = await llmsTxt(root(), { write: options.check !== true });
      emit(result, options.json === true, formatLlmsTxt);
      if (options.check === true && !result.upToDate) {
        process.stderr.write('llms.txt is out of date — run `sdlc llms-txt` and commit it\n');
        process.exitCode = 1;
      }
    });

  program
    .command('docs-visibility')
    .description('what the evidence associates with a doc being found and cited (offline)')
    .option('--json', 'emit JSON')
    .action(async (options: { json?: boolean }): Promise<void> => {
      const result = await docVisibility(root());
      emit(result, options.json === true, formatDocVisibility);
      // Advisory, like doc-health. Every finding here is a judgement about
      // prose, and an exit code would make a hedge count fail somebody's build.
    });

  program
    .command('views')
    .description('saved board views from docs/views/')
    .option('--role <role>', 'only views offered to this role')
    .option('--json', 'emit JSON')
    .action(async (options: { role?: string; json?: boolean }): Promise<void> => {
      const role = options.role === undefined ? undefined : (options.role as RoleKey);
      if (role !== undefined && !(ROLE_KEYS as readonly string[]).includes(role)) {
        // Named rather than silently returning everything. A typo'd role that
        // listed every view would read as "this role sees all of them".
        process.stderr.write(
          `unknown role "${String(options.role)}" — expected one of ${ROLE_KEYS.join(', ')}\n`,
        );
        process.exitCode = 2;
        return;
      }
      const result = await listViews(root(), role);
      emit(result, options.json === true, formatViews);
      // Non-zero when a file failed to load. Unlike a gate, a broken view costs
      // a menu entry rather than a missed check — but a file the author thinks
      // is working and is not still deserves a failing command.
      if (!result.ok) process.exitCode = 1;
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
    .command('watch')
    .description('poll advisories against installed versions; report what changed (P2-SEC-09)')
    .option('--dry-run', 'report the delta without updating the stored record')
    .option('--json', 'emit JSON')
    .action(async (options: { dryRun?: boolean; json?: boolean }): Promise<void> => {
      const result = await watchDependencies(root(), {
        ...(options.dryRun === true ? { dryRun: true } : {}),
      });
      emit(result, options.json === true, (r: Awaited<ReturnType<typeof watchDependencies>>) =>
        formatWatch(r),
      );
      // A package that gained an advisory since the last poll fails the
      // process, so a scheduled run is noticed rather than logged.
      if (result.delta.findings.length > 0) process.exitCode = 1;
    });

  deps
    .command('licenses')
    .description('flag dependency licenses incompatible with this project’s (P2-SEC-08)')
    .option('--project-license <spdx>', 'override the project’s own license')
    .option('--json', 'emit JSON')
    .action(async (options: { projectLicense?: string; json?: boolean }): Promise<void> => {
      const result = await checkLicenses(root(), {
        ...(options.projectLicense === undefined ? {} : { projectLicense: options.projectLicense }),
      });
      emit(result, options.json === true, (r: Awaited<ReturnType<typeof checkLicenses>>) =>
        formatLicenses(r),
      );
    });

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
    .command('guard')
    .description('flag changes that re-add something a past revert removed (P2-GIT-01)')
    .option('--base <ref>', 'compare against this ref', 'HEAD')
    .option('--json', 'emit JSON')
    .action(async (options: { base?: string; json?: boolean }): Promise<void> => {
      const result = await checkGuard(root(), {
        ...(options.base === undefined ? {} : { base: options.base }),
      });
      emit(result, options.json === true, (r: Awaited<ReturnType<typeof checkGuard>>) =>
        formatGuardCheck(r),
      );
      // Warns loudly; does not block. A guard that blocks on a name collision
      // gets bypassed by habit within a fortnight.
    });

  program
    .command('threat-model')
    .description('check per-tool-surface threat models for coverage (P2-SEC-06)')
    .option('--scaffold <name>', 'write a blank grid for a new surface')
    .option('--components <list>', 'comma-separated components, with --scaffold')
    .option('--json', 'emit JSON')
    .action(
      async (options: {
        scaffold?: string;
        components?: string;
        json?: boolean;
      }): Promise<void> => {
        if (options.scaffold !== undefined) {
          const components = (options.components ?? '')
            .split(',')
            .map((c) => c.trim())
            .filter((c) => c !== '');
          const dir = path.join(root(), THREAT_MODEL_DIR);
          await fs.mkdir(dir, { recursive: true });
          const file = path.join(dir, `${options.scaffold}.json`);
          await fs.writeFile(file, scaffoldThreatModel(options.scaffold, components), 'utf8');
          process.stdout.write(
            `wrote ${path.relative(root(), file)} — ${String(components.length * 6)} cell(s) to disposition\n`,
          );
          return;
        }

        const result = await checkThreatModels(root());
        emit(result, options.json === true, (r: Awaited<ReturnType<typeof checkThreatModels>>) =>
          formatThreatCheck(r),
        );
        if (!result.complete) process.exitCode = 1;
      },
    );

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
    .command('risk')
    .description('detect high-risk surfaces in a diff and the review they require (P2-SEC-03)')
    .option('--base <ref>', 'compare against this ref', 'HEAD')
    // `sdlc advance` records these on its own (P6-WRITEPATH-02). The flag is for
    // recording a risk against a card without attempting a transition — a review
    // that found something, not a step that was blocked.
    .option('--record <work-item-id>', 'write the risk artifacts for this work item')
    .option('--json', 'emit JSON')
    .action(async (options: { base?: string; record?: string; json?: boolean }): Promise<void> => {
      const result = await checkRisk(root(), {
        ...(options.base === undefined ? {} : { base: options.base }),
      });
      if (options.record === undefined) {
        emit(result, options.json === true, (r: Awaited<ReturnType<typeof checkRisk>>) =>
          formatRisk(r),
        );
        return;
      }
      const recorded = await recordRisks(root(), options.record, result.findings);
      emit(
        { ...result, recorded },
        options.json === true,
        (r: typeof result & { recorded: Awaited<ReturnType<typeof recordRisks>> }) =>
          [
            formatRisk(r),
            '',
            r.recorded.created.length === 0
              ? `no new risk artifacts — ${String(r.recorded.alreadyRecorded.length)} already recorded under ${r.recorded.dir}`
              : `recorded under ${r.recorded.dir}:\n${r.recorded.created.map((rec) => `  ${rec.id} — ${rec.surface} (${rec.severity})`).join('\n')}`,
          ].join('\n'),
      );
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
    .option('--target <id>', 'which surface to check against (claude-code, mcp)')
    .option('--json', 'emit JSON')
    .action((options: { target?: string; json?: boolean }): void => {
      const report = doctorSkills({ target: options.target });
      emit(report, options.json === true, (r: ReturnType<typeof doctorSkills>) => formatDoctor(r));
      // An error-severity finding means a compile would drop something. Exiting
      // non-zero is what lets this sit in a pre-commit hook or CI at all.
      if (!report.ok) process.exitCode = 1;
    });

  skills
    .command('compile')
    .description('compile the canonical skills to a configured agent surface')
    // Named, never sniffed (ADR-0007): `detect()` reports, it does not choose.
    .option('--target <id>', 'which surface to compile to (claude-code, mcp)', 'claude-code')
    .option('--dry-run', 'report what would be written without writing it')
    .option('--json', 'emit JSON')
    .action(
      async (options: { target?: string; dryRun?: boolean; json?: boolean }): Promise<void> => {
        const result = await compileSkills(root(), {
          dryRun: options.dryRun === true,
          target: options.target,
        });
        emit(result, options.json === true, (r: Awaited<ReturnType<typeof compileSkills>>) =>
          formatCompile(r, options.dryRun === true),
        );
      },
    );

  const pilot = program
    .command('pilot')
    .description('the external-pilot gate on the public release (ADR-0064)');

  pilot
    .command('template')
    .description('write a report skeleton — which deliberately does not pass `pilot check`')
    .option('--json', 'emit JSON')
    .action(async (options: { json?: boolean }): Promise<void> => {
      const result = await writePilotTemplate(root());
      emit(result, options.json === true, (r: typeof result) =>
        r.created
          ? `${r.path} written. It has no measurements yet and will not pass \`sdlc pilot check\`.`
          : `${r.path} already exists — left alone, in case it holds a real pilot's evidence.`,
      );
    });

  pilot
    .command('check')
    .description('judge the pilot report; exits non-zero until the gate is met')
    .option('--json', 'emit JSON')
    .action(async (options: { json?: boolean }): Promise<void> => {
      const result = await checkPilot(root());
      emit(result, options.json === true, (r: typeof result) => formatPilotCheck(r));
      if (!result.ok) process.exitCode = 1;
    });

  program
    .command('roles')
    .description('the specialist team this project’s stack implies (ADR-0059)')
    .option('--json', 'emit JSON')
    .action(async (options: { json?: boolean }): Promise<void> => {
      const result = await deriveRoles(root());
      emit(result, options.json === true, formatRoles);
      // A broken registry or a team too wide to dispatch exits non-zero; a
      // technology with no specialist does not — that is the registry not
      // having grown yet, and failing on it would make every real project's
      // first run red.
      if (!result.ok) process.exitCode = 1;
    });

  const criteria = program
    .command('criteria')
    .description('the held-out half of a work item’s acceptance (P3-GATE-09, ADR-0037)');

  criteria
    .command('hold-out')
    .argument('<work-item-id>', 'the card')
    .argument('<text>', 'what a realistic use of this would need to be true')
    .description('record a criterion the implementing agent will not see')
    .option('--json', 'emit JSON')
    .action(async (id: string, text: string, options: { json?: boolean }): Promise<void> => {
      const result = await addHeldOut(root(), id, text);
      emit(result, options.json === true, (r: typeof result) =>
        [
          `${r.workItemId}: ${String(r.count)} held-out criteri${r.count === 1 ? 'on' : 'a'}, latest by ${r.authorDisplayName}`,
          '  Stored outside the working tree. There is no command that prints it back —',
          '  a command that printed it would be a command an agent could run.',
        ].join('\n'),
      );
    });

  criteria
    .command('status')
    .argument('<work-item-id>', 'the card')
    .description('how many are held out, and the visible-vs-held-out delta')
    .option('--changed-lines <n>', 'size of the change, for the predicted gap', '0')
    .option(
      '--record',
      'append this measurement to the trend — off by default, so looking at the status does not become the trend',
    )
    .option('--json', 'emit JSON')
    .action(
      async (
        id: string,
        options: { changedLines?: string; record?: boolean; json?: boolean },
      ): Promise<void> => {
        const changed = Number.parseInt(options.changedLines ?? '0', 10);
        const result = await criteriaStatus(root(), id, {
          changedLines: Number.isNaN(changed) ? 0 : changed,
          record: options.record,
        });
        emit(result, options.json === true, formatCriteria);
        if (!result.ok) process.exitCode = 1;
      },
    );

  const gates = program
    .command('gates')
    .description('gate policies: the YAML in docs/gates/, compiled and asked about (ADR-0005)');

  gates
    .command('list')
    .description('load every policy file, rebuild the compiled mirror, and report')
    .option('--json', 'emit JSON')
    .action(async (options: { json?: boolean }): Promise<void> => {
      const result = await listGates(root());
      emit(result, options.json === true, formatGates);
      // A file that does not load leaves a gate silently not gating, and that
      // looks exactly like a card nobody wrote a policy for.
      if (!result.ok) process.exitCode = 1;
    });

  gates
    .command('quorum')
    .argument('<work-item-id>', 'the card to ask about')
    .description('who still has to approve this card, and why')
    .option('--path <glob...>', 'files the change touches, for path-scoped policies')
    .option('--json', 'emit JSON')
    .action(async (id: string, options: { path?: string[]; json?: boolean }): Promise<void> => {
      const result = await checkQuorum(root(), id, { paths: options.path ?? [] });
      emit(result, options.json === true, formatQuorumCheck);
      if (!result.ok) process.exitCode = 1;
    });

  gates
    .command('approve')
    .argument('<work-item-id>', 'the card')
    .argument('<gate>', 'the gate name, e.g. review')
    .description('record an approval, with the policy values it was taken under (ADR-0035)')
    .option('--role <role>', 'the role you are approving as — must be one you hold', 'eng-lead')
    .option('--json', 'emit JSON')
    .action(
      async (
        id: string,
        gate: string,
        options: { role?: string; json?: boolean },
      ): Promise<void> => {
        const result = await approveGate(root(), id, gate, options.role ?? 'eng-lead');
        emit(result, options.json === true, (r: typeof result) =>
          [
            `${r.workItemId} / ${gate}: approval #${String(r.approvalId)} as ${r.role}`,
            `  ${r.satisfied ? 'the gate now passes' : 'the gate is still waiting on somebody'}`,
            '  The policy values in force were snapshotted onto the audit row — by value, because',
            '  the policy will change and what was decided today should not change with it.',
          ].join('\n'),
        );
      },
    );

  gates
    .command('revoke')
    .argument('<approval-id>', 'the approval to withdraw')
    .description('withdraw an approval and re-open the gate; an append, never an erase')
    .requiredOption('--reason <text>', 'why — an unexplained retraction cannot be read later')
    .option('--role <role>', 'the role you are acting as', 'eng-lead')
    .option('--json', 'emit JSON')
    .action(
      async (
        id: string,
        options: { reason: string; role?: string; json?: boolean },
      ): Promise<void> => {
        const result = await revokeApproval(
          root(),
          Number.parseInt(id, 10),
          options.role ?? 'eng-lead',
          options.reason,
        );
        emit(result, options.json === true, (r: typeof result) =>
          [
            `approval #${String(r.approvalId)} withdrawn (${r.kind}); gate ${String(r.gateId)} re-opened`,
            `  ${r.impact.summary}`,
          ].join('\n'),
        );
      },
    );

  gates
    .command('simulate')
    .argument(
      '<proposed-dir>',
      'a directory of proposed policy YAML to compare against docs/gates/',
    )
    .description('which cards start or stop being blocked, before the change lands')
    .option('--json', 'emit JSON')
    .action(async (dir: string, options: { json?: boolean }): Promise<void> => {
      const result = await simulatePolicyChange(root(), dir);
      emit(result, options.json === true, formatSimulation);
    });

  const access = program
    .command('access')
    .description('who may do what — roles, memberships and the capability check (ADR-0010)');

  access
    .command('policy')
    .description('the role × action table, read from the database, and any drift from the code')
    .option('--json', 'emit JSON')
    .action(async (options: { json?: boolean }): Promise<void> => {
      const result = await showPolicy(root());
      emit(result, options.json === true, formatPolicy);
      // Drift is a refusal. A permission the code has and the rows do not
      // passes every unit test and refuses every real user.
      if (!result.ok) process.exitCode = 1;
    });

  access
    .command('whoami')
    .description('the human actor for this workspace, bootstrapped from git config user.email')
    .option('--json', 'emit JSON')
    .action(async (options: { json?: boolean }): Promise<void> => {
      const result = await whoami(root());
      emit(result, options.json === true, (r: typeof result) =>
        [
          `${r.actor.displayName} — ${r.actor.kind} ${r.actor.id}`,
          `  ${r.created ? 'created' : 'found'} from ${r.source}`,
          `  roles: ${
            r.actor.roles.length === 0
              ? 'none yet — `sdlc access grant` gives one'
              : r.actor.roles
                  .map((role) =>
                    role.expiresAt === null ? role.key : `${role.key} until ${role.expiresAt}`,
                  )
                  .join(', ')
          }`,
        ].join('\n'),
      );
    });

  access
    .command('grant')
    .argument('<actor>', 'actor id, email or display name')
    .argument('<role>', ROLE_KEYS.join(' | '))
    .description('give an actor a role, optionally with an end date')
    .option('--until <iso>', 'when the grant lapses (ADR-0035) — leave off for indefinite')
    .option('--json', 'emit JSON')
    .action(
      async (
        actor: string,
        role: string,
        options: { until?: string; json?: boolean },
      ): Promise<void> => {
        const result = await grantRole(root(), actor, role, options.until);
        emit(result, options.json === true, (r: typeof result) =>
          [
            `${r.actor.displayName} ${r.alreadyHeld ? 'already held' : 'now holds'} "${r.role}"` +
              (r.expiresAt === null ? '' : ` until ${r.expiresAt}`),
            r.expiresAt === null
              ? '  Indefinite. A grant with no end date is the ordinary way a permission model rots (ADR-0035).'
              : '  Lapses on its own — `capability()` reads the date, not just the row.',
          ].join('\n'),
        );
      },
    );

  access
    .command('grants')
    .description(
      'every membership, when it lapses, and which roles are about to lose their last holder',
    )
    .option('--window <days>', 'how far ahead to warn', '14')
    .option('--json', 'emit JSON')
    .action(async (options: { window?: string; json?: boolean }): Promise<void> => {
      const days = Number.parseInt(options.window ?? '14', 10);
      const result = await listGrants(root(), Number.isNaN(days) ? 14 : days);
      emit(result, options.json === true, formatGrants);
      // A role with no live holder is the ADR-0035 deadlock: a gate requiring
      // it cannot open, and nothing else says so until somebody tries.
      if (result.uncovered.length > 0) process.exitCode = 1;
    });

  access
    .command('check')
    .argument('<actor>', 'actor id, email or display name')
    .argument('<action>', PERMISSION_KEYS.join(' | '))
    .argument('<work-item-id>', 'the card the action is on')
    .description('would this actor be allowed, and on what grounds')
    .option('--json', 'emit JSON')
    .action(
      async (
        actor: string,
        action: string,
        id: string,
        options: { json?: boolean },
      ): Promise<void> => {
        const result = await checkAccess(root(), actor, action, id);
        emit(result, options.json === true, formatAccessCheck);
        if (!result.ok) process.exitCode = 1;
      },
    );

  const mcp = program
    .command('mcp')
    .description('external MCP servers: what is consented, what is read-only, what needs a person');

  mcp
    .command('list')
    .description('every registered server, its consent state and each tool’s access level')
    .option('--json', 'emit JSON')
    .action(async (options: { json?: boolean }): Promise<void> => {
      const result = await listMcpServers(root());
      emit(result, options.json === true, formatMcpList);
      // Drift is a refusal, not a note: a consented server whose tool set moved
      // is one the user agreed to under different terms.
      if (!result.ok) process.exitCode = 1;
    });

  mcp
    .command('suggest')
    .description('servers worth considering for this project’s stack — grounded, and opt-in')
    .option('--json', 'emit JSON')
    .action(async (options: { json?: boolean }): Promise<void> => {
      const result = await suggestMcpServers(root());
      emit(result, options.json === true, (r: typeof result) => formatRecommendations(r.result));
      // Deliberately exit 0 whatever it finds. A suggestion is not a finding,
      // and a recommender that fails a build because it had an idea is one
      // people turn off.
    });

  mcp
    .command('consent <id>')
    .description('record consent to a server, pinning the tool set as it stands now')
    .option('--json', 'emit JSON')
    .action(async (id: string, options: { json?: boolean }): Promise<void> => {
      const result = await setMcpConsent(root(), id, 'consented');
      emit(
        result,
        options.json === true,
        (r: typeof result) =>
          `${r.id}: consented, ${String(r.toolsPinned)} tool(s) pinned` +
          (r.drift?.drifted === true
            ? `\n  newly agreed to: ${[...r.drift.added, ...r.drift.redescribed].join(', ')}`
            : ''),
      );
    });

  mcp
    .command('decline <id>')
    .description('record a decline — kept, and revisable later')
    .option('--reason <text>', 'why, for whoever reads this next')
    .option('--json', 'emit JSON')
    .action(async (id: string, options: { reason?: string; json?: boolean }): Promise<void> => {
      const result = await setMcpConsent(root(), id, 'declined', { reason: options.reason });
      emit(
        result,
        options.json === true,
        (r: typeof result) => `${r.id}: declined — recorded, and revisable`,
      );
    });

  mcp
    .command('check <id> <tool>')
    .description('whether one call would be permitted, without making it')
    .option('--write', 'the call would write — requires a human approval')
    .option('--json', 'emit JSON')
    .action(async (id: string, toolName: string, options: { write?: boolean; json?: boolean }) => {
      const result = await checkMcpCall(
        root(),
        id,
        toolName,
        options.write === true ? 'write' : 'read',
      );
      emit(result, options.json === true, (r: typeof result) =>
        formatCallVerdict(r.server, r.tool, r.verdict),
      );
      if (!result.verdict.allowed) process.exitCode = 1;
    });

  const e2e = program
    .command('e2e')
    .description(
      'the disposable-credential harness: what a run may point at, and what it may keep (ADR-0052)',
    );

  e2e
    .command('check')
    .description('check the target and credentials before a run starts')
    .requiredOption('--run <id>', 'this run’s id — must appear in the tenant id')
    .option('--json', 'emit JSON')
    .action(async (options: { run: string; json?: boolean }): Promise<void> => {
      const result = await checkE2e(root(), options.run);
      emit(result, options.json === true, formatE2eCheck);
      // Non-zero so this can gate the run that follows it. A check whose result
      // nothing reads is a check nobody ran.
      if (!result.ok) process.exitCode = 1;
    });

  e2e
    .command('seal <directory>')
    .description('scan captured artifacts before any of them are persisted')
    .requiredOption('--run <id>', 'the run whose artifacts these are')
    .option('--tore-down', 'the declared teardown was observed to have run')
    .option('--json', 'emit JSON')
    .action(
      async (
        directory: string,
        options: { run: string; toreDown?: boolean; json?: boolean },
      ): Promise<void> => {
        const workspace = root();
        const result = await sealE2eEvidence(
          workspace,
          options.run,
          directory,
          options.toreDown === true,
        );
        emit(result, options.json === true, (r: typeof result) => formatE2eSeal(r, workspace));
        if (!result.run.ok) process.exitCode = 1;
      },
    );

  const improve = program
    .command('improve')
    .description(
      'the bounded trace → propose → validate → human-merge loop (ADR-0026). Nothing here redeploys.',
    );

  improve
    .command('mine <traces>')
    .description(
      'read a trace log and report recurring patterns — proposes nothing, applies nothing',
    )
    .option('--json', 'emit JSON')
    .action(async (traces: string, options: { json?: boolean }): Promise<void> => {
      const result = await mineImprovements(root(), traces);
      emit(result, options.json === true, formatMining);
    });

  improve
    .command('review')
    .description('judge the waiting proposals against their held-out runs')
    .option('--tier <tier>', 'the model tier production actually uses', 'medium')
    .option('--json', 'emit JSON')
    .action(async (options: { tier?: string; json?: boolean }): Promise<void> => {
      const result = await reviewImprovements(root(), options.tier ?? 'medium');
      emit(result, options.json === true, formatReview);
    });

  improve
    // The human step, and a separate command on purpose: nothing in `mine` or
    // `review` can reach it, and no flag on either shortcuts it (ADR-0026 §5).
    .command('approve <id>')
    .description('merge-approve a validated proposal, as a person')
    .requiredOption('--as <actor>', 'who you are — recorded on the proposal')
    .option('--tier <tier>', 'the model tier production actually uses', 'medium')
    .option('--json', 'emit JSON')
    .action(
      async (id: string, options: { as: string; tier?: string; json?: boolean }): Promise<void> => {
        const result = await approveImprovement(root(), id, options.as, options.tier ?? 'medium');
        emit(result, options.json === true, (r: typeof result) => formatProposalVerdict(r.verdict));
        // An approval that did not carry — because the proposal was never
        // validated, or was validated on the wrong tier — exits non-zero. It is
        // recorded either way; what must not happen is a person believing they
        // merged something they did not.
        if (result.verdict.state !== 'approved') process.exitCode = 1;
      },
    );

  const research = program
    .command('research')
    .description(
      'the per-technology research folders ADR-0045 requires, and whether they are usable',
    );

  research
    .command('scan')
    .description("read the project's manifest and report which technologies have usable research")
    .option('--json', 'emit JSON')
    .action(async (options: { json?: boolean }): Promise<void> => {
      const result = await scanResearch(root());
      emit(result, options.json === true, formatResearchScan);
    });

  research
    .command('check')
    .description('the same scan, exit-coded, for a gate')
    .option('--json', 'emit JSON')
    .action(async (options: { json?: boolean }): Promise<void> => {
      const result = await scanResearch(root());
      emit(result, options.json === true, formatResearchScan);
      // A technology in the manifest with no usable research is the state
      // ADR-0045 exists to stop code being written in. Exiting non-zero is what
      // lets this sit in CI at all.
      if (!result.ok) process.exitCode = 1;
    });

  research
    .command('new <tech>')
    .description('create the dated folder skeleton for one technology')
    .option('--cadence <cadence>', 'how fast the tech moves: churning|active|stable|spec', 'active')
    .option('--json', 'emit JSON')
    .action(async (tech: string, options: { cadence?: string; json?: boolean }): Promise<void> => {
      const cadence = options.cadence ?? 'active';
      if (!(cadence in REFRESH_CADENCES)) {
        // Named rather than defaulted. A typo'd cadence that silently becomes
        // 90 days sets a refresh clock nobody chose.
        throw new Error(
          `unknown cadence "${cadence}" — one of ${Object.keys(REFRESH_CADENCES).join(', ')}`,
        );
      }
      const result = await newResearch(root(), tech, {
        cadence: cadence as RefreshCadence,
      });
      emit(result, options.json === true, formatNewResearch);
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

  program
    .command('plugins')
    .description('list the layers this project has installed, and any that would not load')
    .option('--json', 'emit JSON')
    .action(async (options: { json?: boolean }) => {
      const discovery = await discoverPlugins({ projectRoot: root() });
      // Reported without registering. `sdlc plugins` has to be usable *because*
      // a layer is misbehaving, so it must not be the command that loads it
      // into the running program.
      emit(discovery, options.json === true, formatPlugins);
      if (discovery.refused.length > 0) process.exitCode = 1;
    });

  program
    .command('serve')
    .description('serve the board, the read API and the live socket on one loopback port')
    .option('-p, --port <number>', 'port to listen on', '4600')
    .option('--host <host>', 'interface to bind', '127.0.0.1')
    .option('--ui <dir>', 'a built board to serve instead of the bundled one')
    .action(async (options: { port: string; host: string; ui?: string }) => {
      const result = await serve({
        root: root(),
        port: Number(options.port),
        host: options.host,
        ...(options.ui === undefined ? {} : { uiDir: options.ui }),
      });
      process.stdout.write(
        [
          `daemon listening on ${result.url}`,
          result.servingUi === null
            ? 'no built board found — API and socket only (run `pnpm --filter @sdlc-on-fire/ui build`)'
            : `serving the board from ${result.servingUi}`,
          `reconciled ${String(result.reconciled)} file(s) that changed while it was not running`,
          result.budget === null
            ? 'embedded database — no shared connection budget applies'
            : `connection budget: ${String(result.budget.current)}/${String(result.budget.capacity)} daemon(s)`,
          result.watching
            ? 'watching the workspace — file changes reach the board without a refresh'
            : 'not watching: the board will not change until this restarts',
          // PGlite is single-connection. Saying so here saves the user
          // discovering it from a lock error on their next command.
          'while this runs it owns the database — other `sdlc` commands that need it will wait',
          'press ctrl-c to stop',
        ].join('\n') + '\n',
      );
      // Held open deliberately: a server that returns is a server that exits.
      await new Promise<void>((resolve) => {
        const stop = (): void => {
          void result.close().then(resolve);
        };
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
      });
    });

  const metrics = program
    .command('metrics')
    .description('flow and delivery-performance metrics, read from what actually happened');

  metrics
    .command('held-out')
    .description(
      'the visible-vs-held-out gap and where it is going — the one honest measure of the repair loop',
    )
    .option('--json', 'emit JSON')
    .action(async (options: { json?: boolean }) => {
      const report = await heldOutReport(root());
      emit(report, options.json === true, formatHeldOut);
      // A widening gap is the alert this whole feature exists to produce.
      if (report.widening.length > 0) process.exitCode = 1;
    });

  metrics
    .command('flow')
    .description('per-stage time, the binding constraint, flow efficiency and rework')
    .option('--json', 'emit JSON')
    .action(async (options: { json?: boolean }) => {
      const report = await flowReport(root());
      emit(report, options.json === true, formatFlow);
    });

  metrics
    .command('agents')
    .description('agent-run count, cost and failure reasons, from the recorded runs')
    .option('--json', 'emit JSON')
    .action(async (options: { json?: boolean }) => {
      const report = await agentRunReport(root());
      emit(report, options.json === true, formatAgentRuns);
    });

  metrics
    .command('blocked')
    .description('time each work item spent waiting on a gate')
    .option('--json', 'emit JSON')
    .action(async (options: { json?: boolean }) => {
      const report = await blockedReport(root());
      emit(report, options.json === true, formatBlocked);
    });

  metrics
    .command('governance')
    .description('gate pass rates, human interventions and insertion churn')
    .option('--json', 'emit JSON')
    .action(async (options: { json?: boolean }) => {
      const report = await governanceReport(root());
      emit(report, options.json === true, formatGovernance);
    });

  metrics
    .command('retrieval')
    .description('precision@k of the real retriever against the judged relevance set')
    .option('-k, --k <n>', 'how many results to score', '10')
    .option('--json', 'emit JSON')
    .action(async (options: { k: string; json?: boolean }) => {
      const report = await retrievalReport(root(), Number(options.k));
      emit(report, options.json === true, formatRetrieval);
    });

  metrics
    .command('dora')
    .description("DORA's five metrics — reported together, never one at a time")
    .option('--days <n>', 'window in days', '30')
    .option('--json', 'emit JSON')
    .action(async (options: { days: string; json?: boolean }) => {
      const report = await doraFromWorkspace(root(), Number(options.days));
      emit(report, options.json === true, formatDora);
    });

  return program;
}

/**
 * Whether this process was started *as* the CLI binary.
 *
 * The guard exists so importing this module from a test does not parse the test
 * runner's argv. It has to survive a symlink, and that is the whole story: npm
 * installs a bin as `node_modules/.bin/sdlc` symlinked at `dist/index.js`, so
 * `argv[1]` is `.../.bin/sdlc` while `import.meta.url` is `.../dist/index.js`.
 *
 * The previous version compared `import.meta.url.endsWith(basename(argv[1]))`,
 * i.e. did `…/dist/index.js` end with `sdlc`. It does not. **Every installed
 * copy of this CLI did nothing and exited 0** — `sdlc --help`, `sdlc init`, all
 * of it, silent success. Nothing caught it because every test and every manual
 * check invoked `node dist/index.js` directly, where the basenames happen to
 * match. It took installing the packed tarball and running the shim.
 *
 * Comparing resolved real paths is the check that was meant: it follows the
 * symlink on both sides and asks whether they are the same file.
 */
function invokedAsBinary(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    // A deleted or unreadable entry point is not this module.
    return false;
  }
}

if (invokedAsBinary()) {
  const program = buildProgram();

  // Layers are registered before parse, so a plugin's command exists by the
  // time the argument naming it is resolved. Discovery never throws: a broken
  // third-party layer becomes a row in `sdlc plugins`, not a CLI that will not
  // start.
  // Commander reports its own failures — unknown command, missing required
  // option, bad argument — and exits without ever reaching the promise chain
  // below. Those are the *earliest* failures an agent can hit and were the
  // loudest prose leak, so they route through the same reporter.
  if (wantsJson(process.argv)) {
    // Applied to every command, not only the root.
    //
    // Commander does not inherit `exitOverride` or `configureOutput` down to
    // subcommands, and the first version of this only covered the root — so
    // `sdlc nonsense --json` produced a document while `sdlc new --json`
    // (missing required argument, raised by the *subcommand*) still leaked
    // prose to stderr and left stdout empty. The half that worked is the half
    // that hid the half that did not.
    const applyJsonFailureContract = (command: Command): void => {
      command.exitOverride((commanderError) => {
        // `--help` and `--version` arrive here having already written their
        // output and succeeded. Turning those into an error document would
        // report a failure that did not happen.
        if (commanderError.exitCode === 0) {
          process.exitCode = 0;
          return;
        }
        reportFailure(commanderError, process.argv);
        throw commanderError;
      });
      command.configureOutput({
        // Suppress commander's own stderr prose: the JSON document is the
        // answer, and writing both leaves an agent parsing a stream whose
        // second half is unstructured.
        writeErr: () => undefined,
      });
      for (const child of command.commands) applyJsonFailureContract(child);
    };
    applyJsonFailureContract(program);
  }

  discoverPlugins({ projectRoot: projectRootFromArgv(process.argv.slice(2), process.cwd()) })
    .then((discovery) => {
      const registered = registerPlugins(program, discovery);
      for (const entry of registered.refused) {
        process.stderr.write(
          `sdlc: layer ${entry.package} not loaded [${entry.refusal}] ${entry.because}\n`,
        );
      }
    })
    .catch(() => undefined)
    .then(() => program.parseAsync(process.argv))
    .catch((error: unknown) => {
      reportFailure(error, process.argv);
    });
}
