import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { applySchema } from '@sdlc-on-fire/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { whoami } from './access.js';
import { init, openWorkspaceDatabase } from './commands.js';
import { addHeldOut, criteriaStatus } from './criteria.js';

/**
 * `sdlc criteria` against a real workspace (P3-GATE-09).
 *
 * The property this suite exists for is a negative one: the text must not come
 * back out. Everything else is arithmetic.
 */

const run = promisify(execFile);
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
const RM_RETRY = { maxRetries: 5, retryDelay: 100 } as const;
const SECRET = 'importing a 10MB CSV does not exhaust memory';

let root: string;

const CARD = [
  '---',
  '$schema: https://sdlc-on-fire.dev/schema/work-item.json',
  'id: FEAT-001',
  'kind: feature',
  'title: CSV import',
  'status: In Progress',
  'lifecycle_state: implement',
  'work_type: feature',
  'preset: standard',
  'risk_level: low',
  'verify: node -e "process.exit(0)"',
  'done:',
  '  - the CSV parser handles quoted commas',
  'created_at: 2026-08-10T00:00:00.000Z',
  'updated_at: 2026-08-10T00:00:00.000Z',
  '---',
  '',
  'body',
  '',
].join('\n');

async function seedCard(claimedBy: string | null = null): Promise<void> {
  const { db } = await openWorkspaceDatabase(root);
  try {
    await applySchema(db);
    await db.query(
      `INSERT INTO work_items (id, type, title, status, lifecycle_state, file_path, content_hash, claimed_by)
       VALUES ('FEAT-001','feature','CSV import','In Progress','implement','kanban/_inbox/FEAT-001.md','h',$1)
       ON CONFLICT (id) DO UPDATE SET claimed_by = EXCLUDED.claimed_by;`,
      [claimedBy],
    );
  } finally {
    await db.close();
  }
}

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sdlcof-crit-')));
  await run('git', ['init', '-q'], { cwd: root });
  await run('git', ['config', 'user.email', 'ada@example.test'], { cwd: root });
  await run('git', ['config', 'user.name', 'Ada'], { cwd: root });
  await init(root, { database: 'skip' });
  await fs.mkdir(path.join(root, 'kanban', '_inbox'), { recursive: true });
  await fs.writeFile(path.join(root, 'kanban', '_inbox', 'FEAT-001.md'), CARD, 'utf8');
  await seedCard();
}, 90_000);

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true, ...RM_RETRY });
});

describe('the text does not come back out', () => {
  it('is absent from status output and from its JSON', async () => {
    // The whole point. A command that printed it would be a command an agent
    // could run.
    await addHeldOut(root, 'FEAT-001', SECRET);

    const { stdout } = await run('node', [CLI, '-C', root, 'criteria', 'status', 'FEAT-001'], {
      cwd: root,
    });
    expect(stdout).not.toContain('10MB');
    expect(stdout).toContain('1 held out');

    const json = await run('node', [CLI, '-C', root, 'criteria', 'status', 'FEAT-001', '--json'], {
      cwd: root,
    });
    expect(json.stdout).not.toContain('10MB');
  }, 120_000);

  it('is absent from the in-process result object too', async () => {
    // Not only from the rendering — the shape itself has no field for it.
    await addHeldOut(root, 'FEAT-001', SECRET);
    const status = await criteriaStatus(root, 'FEAT-001');
    expect(JSON.stringify(status)).not.toContain('10MB');
    expect(status.summary.count).toBe(1);
  }, 90_000);

  it('has no subcommand that lists them', async () => {
    const { stdout } = await run('node', [CLI, '-C', root, 'criteria', '--help'], { cwd: root });
    expect(stdout).toContain('hold-out');
    expect(stdout).toContain('status');
    expect(stdout).not.toContain('list');
    expect(stdout).not.toContain('show');
  }, 90_000);
});

describe('a different actor', () => {
  it('refuses a criterion from the actor who claimed the item', async () => {
    const me = await whoami(root);
    await seedCard(me.actor.id);
    await expect(addHeldOut(root, 'FEAT-001', SECRET)).rejects.toThrow(/same-author/);
  }, 90_000);

  it('accepts it when somebody else holds the claim', async () => {
    await seedCard('00000000-0000-0000-0000-000000000000');
    // The claim points at an actor that is not us, which is the case that
    // matters — it is the implementer's identity that must differ.
    await expect(addHeldOut(root, 'FEAT-001', SECRET)).resolves.toBeDefined();
  }, 90_000);

  it('refuses a restatement of a visible criterion', async () => {
    await expect(
      addHeldOut(root, 'FEAT-001', 'The CSV parser handles quoted commas.'),
    ).rejects.toThrow(/restates-visible/);
  }, 90_000);

  it('refuses an agent as the author, at the database', async () => {
    // Belt and braces: the application layer resolves the author from git
    // config, so an agent cannot normally get here — the trigger is what holds
    // if anything ever writes the row directly.
    const { db } = await openWorkspaceDatabase(root);
    try {
      await applySchema(db);
      const [agent] = await db.query<{ id: string }>(
        `INSERT INTO actors (kind, display_name, agent_target) VALUES ('agent','codex','codex') RETURNING id;`,
      );
      await expect(
        db.query(
          'INSERT INTO held_out_criteria (work_item_id, text, author_actor_id) VALUES ($1,$2,$3);',
          ['FEAT-001', 'anything', agent?.id ?? ''],
        ),
      ).rejects.toThrow(/agent cannot author/);
    } finally {
      await db.close();
    }
  }, 90_000);
});

describe('what status reports when there is nothing', () => {
  it('says the delta is unmeasured rather than fine', async () => {
    const { stdout } = await run('node', [CLI, '-C', root, 'criteria', 'status', 'FEAT-001'], {
      cwd: root,
    });
    expect(stdout).toContain('Δ unmeasured');
    expect(stdout).toContain('not measurable, only assertable');
  }, 90_000);

  it('quotes the predicted gap for a large change', async () => {
    const { stdout } = await run(
      'node',
      [CLI, '-C', root, 'criteria', 'status', 'FEAT-001', '--changed-lines', '10000'],
      { cwd: root },
    );
    expect(stdout).toContain('27pp');
  }, 90_000);
});
