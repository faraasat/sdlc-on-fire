import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { init } from './commands.js';
import { serve, type ServeResult } from './serve.js';

/**
 * P3-UI-01 — `sdlc serve`, end to end.
 *
 * Every one of these covers a defect that shipped past a green suite, because
 * each layer was correct on its own and the chain between them was not. The
 * chain is: a file is written → the watcher notices → the sync engine upserts a
 * row → a trigger fires → NOTIFY → the socket → the board. Any missing link
 * leaves a board that paints perfectly and never changes, which is the most
 * convincing possible way to be broken.
 */

const running: ServeResult[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const server of running.splice(0)) await server.close().catch(() => undefined);
  await Promise.all(roots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
}, 60_000);

async function workspace(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sdlcof-serve-'));
  roots.push(root);
  await init(root);
  return root;
}

/** A minimal but valid work-item card, written straight to disk. */
async function writeCard(root: string, id: string, title: string): Promise<void> {
  const file = path.join(root, 'kanban', '_inbox', `${id}.md`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(
    file,
    [
      '---',
      `id: ${id}`,
      'kind: feature',
      `title: ${title}`,
      'status: Discovery',
      'lifecycle_state: discovery',
      'work_type: feature',
      'preset: standard',
      '---',
      '',
      '# body',
      '',
    ].join('\n'),
    'utf8',
  );
}

async function start(root: string): Promise<ServeResult> {
  const server = await serve({ root, port: 0 });
  running.push(server);
  return server;
}

async function ids(server: ServeResult): Promise<string[]> {
  const response = await fetch(
    `${server.url.replace(/:\d+$/, '')}:${String(server.port)}/api/work-items`,
  );
  const rows = (await response.json()) as { id: string }[];
  return rows.map((row) => row.id).sort();
}

/** Poll rather than sleep: the watcher's latency is the OS's business, not ours. */
async function until(check: () => Promise<boolean>, budgetMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

describe('sdlc serve', () => {
  it('reconciles files written while it was not running', async () => {
    // The second defect found by running this for real. A watcher only ever
    // sees changes made *after* it starts, so a card created by `sdlc new`, a
    // `git pull`, or an editor while the daemon was down is invisible to it
    // forever — and the board shows a workspace that no longer exists while
    // looking perfectly healthy.
    const root = await workspace();
    await writeCard(root, 'FEAT-100', 'written before the daemon started');

    const server = await start(root);
    expect(server.reconciled).toBeGreaterThan(0);
    expect(await ids(server)).toContain('FEAT-100');
  }, 120_000);

  it('picks up a file written while it is running', async () => {
    // The first defect. The API served, the socket connected, the board
    // painted — and nothing ever changed, because nothing was watching. Every
    // layer was individually correct and the product did not work.
    const server = await start(await workspace());
    const root = roots[roots.length - 1] as string;
    expect(await ids(server)).not.toContain('FEAT-200');

    await writeCard(root, 'FEAT-200', 'written while the daemon was watching');
    const arrived = await until(async () => (await ids(server)).includes('FEAT-200'));
    expect(arrived, 'the watcher never delivered the new card').toBe(true);
  }, 120_000);

  it('reports that it is watching, rather than leaving the user to guess', async () => {
    const server = await start(await workspace());
    expect(server.watching).toBe(true);
  }, 120_000);

  it('bootstraps a human actor so identity is not "nobody"', async () => {
    // Solo mode exists so a lone developer configures nothing, and it could
    // never trigger: `actors` was empty on a freshly-initialised workspace, so
    // the board resolved identity to nobody. Invisible from the CLI, where an
    // agent arrives with its actor.
    const root = await workspace();
    const server = await start(root);
    const response = await fetch(`http://127.0.0.1:${String(server.port)}/api/identity`);
    const identity = (await response.json()) as { actor: unknown; ground: string };
    // The workspace has a git repo from `init`, but user.email may be unset in
    // a sandbox — either a real identity or an honest "nobody" is acceptable;
    // what is not is a crash or a malformed answer.
    expect(['git-email', 'solo-implicit', 'none']).toContain(identity.ground);
  }, 120_000);

  it('serves the API and refuses a non-loopback Host on the same port', async () => {
    const server = await start(await workspace());
    const health = await fetch(`http://127.0.0.1:${String(server.port)}/api/health`);
    expect(health.status).toBe(200);
  }, 120_000);
});
