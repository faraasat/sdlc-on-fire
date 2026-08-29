import { promises as fs } from 'node:fs';
import path from 'node:path';
import { resolveWorkspaceLayout } from '@sdlc-on-fire/core';
import { migrationFiles } from '@sdlc-on-fire/db';
import {
  CANONICAL_SKILLS,
  McpAdapter,
  toolBudget,
  type McpTool,
} from '@sdlc-on-fire/agent-manager';
import { createGitManager } from '@sdlc-on-fire/daemon';
import { openWorkspaceDatabase, readConfig } from './commands.js';

/**
 * `sdlc doctor` (P6-SURFACE-03, FEAT-CLI-007).
 *
 * `skills doctor` already checks whether skills compile. This checks whether the
 * *workspace* is in a state where anything can work at all — the question
 * somebody actually has when a command failed and they do not know why.
 *
 * **Every check reports `pass`, `warn` or `fail`, and a failing check says what
 * to run.** A diagnostic that reports a problem without a next step has moved
 * the user from "it is broken" to "it is broken and now I know a word for it",
 * which is the standard the published-package pilot found this product falling
 * short of (P6-SURFACE-10).
 *
 * **It never repairs anything.** A doctor that silently fixes what it finds
 * makes the next failure harder to understand, because the state it ran against
 * no longer exists. It reports; the user decides.
 */

export const CHECK_STATUSES = ['pass', 'warn', 'fail'] as const;
export type CheckStatus = (typeof CHECK_STATUSES)[number];

export interface Check {
  readonly name: string;
  readonly status: CheckStatus;
  readonly detail: string;
  /** Present on `warn` and `fail`. Absent on `pass`, where there is nothing to do. */
  readonly fix?: string | undefined;
}

/**
 * Named `WorkspaceDoctorReport`, not `DoctorReport`.
 *
 * `agent-manager` already exports a `DoctorReport` for compile-target
 * validation, and two types one word apart describing different things is the
 * vocabulary split this repository has found five times. The compiler caught it
 * here, which is the cheap version.
 */
export interface WorkspaceDoctorReport {
  readonly root: string;
  readonly checks: readonly Check[];
  /** True when nothing failed. A `warn` is survivable; a `fail` is not. */
  readonly healthy: boolean;
}

const pass = (name: string, detail: string): Check => ({ name, status: 'pass', detail });
const warn = (name: string, detail: string, fix: string): Check => ({
  name,
  status: 'warn',
  detail,
  fix,
});
const fail = (name: string, detail: string, fix: string): Check => ({
  name,
  status: 'fail',
  detail,
  fix,
});

export async function workspaceDoctor(root: string): Promise<WorkspaceDoctorReport> {
  const layout = resolveWorkspaceLayout(root);
  const checks: Check[] = [];

  /* -- the workspace itself ------------------------------------------------ */

  let config = null;
  try {
    config = await readConfig(root);
    checks.push(
      config === null
        ? fail('config', `no config at ${layout.configPath}`, 'run `sdlc init` in this directory')
        : pass('config', `${layout.configPath} (database.mode = ${config.database.mode})`),
    );
  } catch (cause) {
    // The message from `readConfig` is already the actionable one (P6-SURFACE-10);
    // repeating it beats paraphrasing it into something vaguer.
    checks.push(
      fail(
        'config',
        cause instanceof Error ? (cause.message.split('\n')[0] ?? 'unreadable') : String(cause),
        'fix the file it names, or delete it and run `sdlc init`',
      ),
    );
  }

  for (const [name, dir] of [
    ['kanban', layout.kanbanDir],
    ['docs', layout.docsDir],
  ] as const) {
    const exists = await fs
      .stat(dir)
      .then((stat) => stat.isDirectory())
      .catch(() => false);
    checks.push(
      exists
        ? pass(name, path.relative(layout.root, dir) || '.')
        : fail(name, `${dir} is missing`, 'run `sdlc init` to scaffold it'),
    );
  }

  /* -- git ----------------------------------------------------------------- */

  const git = createGitManager({ repoRoot: layout.root });
  const isRepo = await git.isRepo().catch(() => false);
  checks.push(
    isRepo
      ? pass('git', 'this workspace is a git repository')
      : // A warning, not a failure. The product works without git — but content
        // is the source of truth here, and content that is not versioned has no
        // history to be the truth *of*.
        warn(
          'git',
          'not a git repository',
          'run `git init` — work items and docs are the source of truth, and nothing is recovering them if they are not versioned',
        ),
  );

  /* -- the database -------------------------------------------------------- */

  if (config !== null) {
    try {
      const { db, mode, describe } = await openWorkspaceDatabase(root);
      try {
        const applied = await db
          .query<{ count: string }>(
            "SELECT count(*)::text AS count FROM information_schema.tables WHERE table_schema = 'public';",
          )
          .catch(() => [{ count: '0' }]);
        const tables = Number(applied[0]?.count ?? 0);
        const expected = (await migrationFiles()).length;
        checks.push(
          tables > 0
            ? pass('database', `${mode} — ${describe}, ${String(tables)} table(s)`)
            : warn(
                'database',
                `${mode} — reachable but empty (${String(expected)} migration(s) available)`,
                'run `sdlc db:up` to apply the schema',
              ),
        );
      } finally {
        await db.close();
      }
    } catch (cause) {
      checks.push(
        fail(
          'database',
          cause instanceof Error ? (cause.message.split('\n')[0] ?? 'unreachable') : String(cause),
          'run `sdlc db:up`; if it is a connected workspace, check `database.url` in the config',
        ),
      );
    }
  }

  /* -- the compiled tool surface ------------------------------------------ */

  // The tripwire, finally consulted (P2-AGT-02). `toolBudget` was written to
  // announce that ADR-0024's deferred-loading condition had been met, was
  // exported, and had NO PRODUCTION CALLER — so when the PAYLOAD workstream took
  // the registry from 5 tools to 21 and tripped it, nothing said so. The tenth
  // read path with no writer in this codebase, and the one whose entire job was
  // to speak up.
  {
    const server = new McpAdapter().compileServer?.(Object.values(CANONICAL_SKILLS));
    const file = server?.files.find((entry) => entry.path.endsWith('.json'));
    const tools =
      file === undefined
        ? []
        : // Parsed back out of the compiled file rather than taken from the
          // adapter's return value, because the file is what a consumer will
          // actually read — measuring anything else would measure our intent.
          ((JSON.parse(file.content) as { tools?: McpTool[] }).tools ?? []);
    const budget = toolBudget(tools);
    checks.push(
      budget.conditionMet
        ? warn(
            'tools',
            budget.because,
            'set `defer_loading` on the MCP toolset entry for the deferred tools — `.mcp/sdlc-on-fire.json` publishes which ones under `_meta`',
          )
        : pass('tools', budget.because),
    );
  }

  /* -- node ---------------------------------------------------------------- */

  const major = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
  checks.push(
    major >= 20
      ? pass('node', `v${process.versions.node}`)
      : fail(
          'node',
          `v${process.versions.node} is below the supported floor`,
          'upgrade to Node 20 or newer',
        ),
  );

  return {
    root: layout.root,
    checks,
    // A `warn` does not make the workspace unhealthy. Treating every advisory as
    // a failure is how a diagnostic becomes a thing people run with `|| true`.
    healthy: !checks.some((check) => check.status === 'fail'),
  };
}

const MARK: Readonly<Record<CheckStatus, string>> = { pass: '✓', warn: '!', fail: '✗' };

export function formatWorkspaceDoctor(report: WorkspaceDoctorReport): string {
  const lines = [`workspace: ${report.root}`, ''];
  for (const check of report.checks) {
    lines.push(`  ${MARK[check.status]} ${check.name.padEnd(9)} ${check.detail}`);
    // Indented under the check it belongs to, so a long list stays readable and
    // the fix is never separated from what it fixes.
    if (check.fix !== undefined) lines.push(`      → ${check.fix}`);
  }
  lines.push(
    '',
    report.healthy
      ? 'no failures.'
      : `${String(report.checks.filter((c) => c.status === 'fail').length)} check(s) failed.`,
  );
  return lines.join('\n');
}
