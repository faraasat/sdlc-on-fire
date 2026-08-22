import { execFile, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A real workspace with a real daemon, for the browser tests to drive.
 *
 * Not a mock server. The defects this suite exists to catch — a drag that does
 * not drop, a drawer that does not open, a chart that renders empty — all live
 * between the browser and the daemon, and a fixture that stubs the API removes
 * exactly the seam under test.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');
const CLI = path.join(REPO, 'packages', 'cli', 'dist', 'index.js');

export interface Harness {
  readonly root: string;
  readonly url: string;
  stop(): Promise<void>;
}

function run(file: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { cwd }, (error) => {
      if (error === null) resolve();
      // Wrapped so the rejection is always an Error: a raw ExecException loses
      // its stack when it crosses the promise boundary, and a fixture that
      // fails without one is a failure nobody can locate.
      else reject(error instanceof Error ? error : new Error(`${file} ${args.join(' ')} failed`));
    });
  });
}

async function waitForHealth(url: string, budgetMs = 60_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/api/health`);
      if (response.ok) return;
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`daemon never became healthy at ${url}`);
}

/** Scaffold a workspace, seed deterministic cards, and serve it. */
export async function startHarness(port: number): Promise<Harness> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sdlcof-e2e-'));

  await run('git', ['init', '-q', '.'], root);
  await run('git', ['config', 'user.email', 'e2e@example.test'], root);
  await run('git', ['config', 'user.name', 'E2E Fixture'], root);
  await run('node', [CLI, '-C', root, 'init'], root);

  // Fixed titles and a fixed order, because a screenshot baseline compares
  // pixels: a card whose title varies per run guarantees a diff every time and
  // the baseline is abandoned within a week.
  for (const [kind, title] of [
    ['feature', 'Add OAuth login'],
    ['bug', 'Fix the CSV parser crash'],
    ['feature', 'Rate-limit the public API'],
  ] as const) {
    await run('node', [CLI, '-C', root, 'new', kind, title], root);
  }

  const child: ChildProcess = execFile('node', [CLI, '-C', root, 'serve', '--port', String(port)], {
    cwd: root,
  });

  const url = `http://127.0.0.1:${String(port)}`;
  await waitForHealth(url);

  return {
    root,
    url,
    stop: async () => {
      child.kill('SIGTERM');
      await new Promise((resolve) => setTimeout(resolve, 500));
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}
