import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveWorkspaceLayout } from '@sdlc-on-fire/core';
import { afterAll, describe, expect, it } from 'vitest';
import { init } from './commands.js';
import { formatWorkspaceDoctor, workspaceDoctor } from './doctor.js';

/**
 * `sdlc doctor` (P6-SURFACE-03).
 *
 * Against real workspaces in real states, because the whole value of the command
 * is what it says when something is actually wrong.
 */
const RM_RETRY = { maxRetries: 5, retryDelay: 100 } as const;
const madeDirs: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  madeDirs.push(dir);
  return dir;
}

afterAll(async () => {
  for (const dir of madeDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true, ...RM_RETRY }).catch(() => undefined);
  }
});

const find = (report: Awaited<ReturnType<typeof workspaceDoctor>>, name: string) =>
  report.checks.find((check) => check.name === name);

describe('doctor', () => {
  it('fails, and says to run init, on a bare directory', async () => {
    // The state a new user is most likely to be in when they first reach for a
    // diagnostic: they ran something, it failed, and they have no context.
    const root = await tempDir('sdlcof-doc-bare-');
    const report = await workspaceDoctor(root);
    expect(report.healthy).toBe(false);
    expect(find(report, 'config')?.status).toBe('fail');
    expect(find(report, 'config')?.fix).toContain('sdlc init');
  }, 90_000);

  it('passes a scaffolded workspace', async () => {
    const root = await fs.realpath(await tempDir('sdlcof-doc-ok-'));
    await init(root, { database: 'skip' });
    const report = await workspaceDoctor(root);
    expect(find(report, 'config')?.status).toBe('pass');
    expect(find(report, 'kanban')?.status).toBe('pass');
    expect(find(report, 'node')?.status).toBe('pass');
  }, 120_000);

  it('warns rather than fails when the workspace is not a git repository', async () => {
    // The product works without git. But content is the source of truth here,
    // and content that is not versioned has no history to be the truth of — so
    // it is worth saying, and not worth refusing over.
    //
    // Checked on a bare directory, because `sdlc init` runs `git init` itself:
    // an initialised workspace is always a repository, and asserting the warning
    // after `init` was asserting something that cannot happen.
    const root = await tempDir('sdlcof-doc-nogit-');
    const report = await workspaceDoctor(root);
    const git = find(report, 'git');
    expect(git?.status).toBe('warn');
    expect(git?.fix).toContain('git init');
  }, 90_000);

  it('gives every non-passing check something to do', async () => {
    // A diagnostic that reports a problem without a next step has moved the user
    // from "it is broken" to "it is broken and I know a word for it".
    const root = await tempDir('sdlcof-doc-fix-');
    const report = await workspaceDoctor(root);
    for (const check of report.checks) {
      if (check.status === 'pass') {
        // And a passing check has nothing to suggest, so it suggests nothing.
        expect(check.fix, check.name).toBeUndefined();
      } else {
        expect(check.fix, check.name).toBeTruthy();
      }
    }
  }, 90_000);

  it('reports the tool budget, which is the tripwire nobody was consulting', async () => {
    // `toolBudget` was written to announce that ADR-0024's deferred-loading
    // condition had been met, exported, and had NO production caller — so when
    // the PAYLOAD workstream took the registry from 5 tools to 21 and tripped
    // it, nothing said so (P2-AGT-02).
    const root = await fs.realpath(await tempDir('sdlcof-doc-tools-'));
    await init(root, { database: 'skip' });
    const report = await workspaceDoctor(root);
    const tools = find(report, 'tools');
    expect(tools).toBeDefined();
    // The registry is past the trigger today, so this is a warning with a fix.
    // If it ever drops back under, the check passes and carries no fix — both
    // states are real and the assertion covers whichever holds.
    expect(tools?.detail).toMatch(/tool\(s\) cost ~\d+ tokens/);
    // Asserted as `warn`, not "warn or pass". The registry is past the trigger
    // today — 21 tools, ~8.9k tokens against 6k — and a test that accepted
    // either state would pass against a doctor that had stopped reporting it,
    // which is the exact defect this closes. If the registry ever shrinks back
    // under the trigger, this fails and makes somebody decide that on purpose.
    expect(tools?.status).toBe('warn');
    expect(tools?.fix).toMatch(/defer_loading/);
  }, 120_000);

  it('names the config file when the config is unreadable', async () => {
    // The pilot's finding: invalid YAML produced "line 2, column 1" and never
    // said which file, that it was the workspace config, or what to do.
    const root = await fs.realpath(await tempDir('sdlcof-doc-yaml-'));
    await init(root, { database: 'skip' });
    await fs.writeFile(resolveWorkspaceLayout(root).configPath, 'database: [unclosed\n', 'utf8');

    const report = await workspaceDoctor(root);
    expect(find(report, 'config')?.status).toBe('fail');
    expect(find(report, 'config')?.detail).toContain('config.yaml');
    expect(formatWorkspaceDoctor(report)).toContain('→');
  }, 120_000);
});
