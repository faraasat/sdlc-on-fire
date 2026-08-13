import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { DOCS_ROOT_FILES, ROOT_FILES } from '@sdlc-on-fire/core';
import { parseWorkItem } from '@sdlc-on-fire/storage';
import { afterEach, describe, expect, it } from 'vitest';
import {
  captureItem,
  init,
  nextSequence,
  readConfig,
  showConfig,
  status,
  triageItem,
} from './commands.js';
import { buildProgram } from './index.js';

const tempDirs: string[] = [];

async function workspace(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sdlcof-cli-')));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('init', () => {
  it('brings the database up rather than reporting success and deferring it', async () => {
    const root = await workspace();
    const result = await init(root);

    // `init` used to create an empty `.sdlcof/db/` and print "Workspace
    // initialised."; PGlite only materialised when something later touched it.
    // On a machine where the runtime cannot start, that reported success and
    // surfaced the failure several commands later, away from the setup step.
    expect(result.database.ready).toBe(true);
    const entries = await fs.readdir(path.join(root, '.sdlcof', 'db'));
    expect(entries).toContain('PG_VERSION');
  }, 120_000);

  it('scaffolds the root whitelist and docs set', async () => {
    const root = await workspace();
    const result = await init(root, { database: 'skip' });

    for (const file of ROOT_FILES) expect(result.created).toContain(file);
    for (const file of DOCS_ROOT_FILES) {
      expect(result.created).toContain(path.join('docs', file));
    }
    await expect(fs.stat(path.join(root, '.sdlcof', 'db'))).resolves.toBeDefined();
    await expect(fs.stat(path.join(root, 'kanban', '_inbox'))).resolves.toBeDefined();
  });

  it('never overwrites an existing file', async () => {
    // Clobbering a user's README for a one-character typo would be unforgivable.
    const root = await workspace();
    await fs.writeFile(path.join(root, 'README.md'), 'MINE\n');

    const result = await init(root, { database: 'skip' });
    expect(result.skipped).toContain('README.md');
    expect(await fs.readFile(path.join(root, 'README.md'), 'utf8')).toBe('MINE\n');
  });

  it('is safe to run twice', async () => {
    const root = await workspace();
    await init(root, { database: 'skip' });
    const second = await init(root, { database: 'skip' });

    expect(second.alreadyInitialised).toBe(true);
    expect(second.created).toEqual([]);
  });

  it('gitignores the whole state directory', async () => {
    const root = await workspace();
    await init(root, { database: 'skip' });
    expect(await fs.readFile(path.join(root, '.gitignore'), 'utf8')).toContain('/.sdlcof/');
  });

  it('appends to an existing gitignore rather than replacing it', async () => {
    const root = await workspace();
    await fs.writeFile(path.join(root, '.gitignore'), 'node_modules\n');
    await init(root, { database: 'skip' });

    const contents = await fs.readFile(path.join(root, '.gitignore'), 'utf8');
    expect(contents).toContain('node_modules');
    expect(contents).toContain('/.sdlcof/');
  });

  it('writes a config that parses', async () => {
    const root = await workspace();
    await init(root, { database: 'skip' });
    const config = await readConfig(root);
    expect(config?.database.mode).toBe('pglite');
  });
});

describe('status', () => {
  it('reports an uninitialised workspace as such', async () => {
    const result = await status(await workspace());
    expect(result.initialised).toBe(false);
    expect(result.databaseMode).toBeNull();
  });

  it('reports an initialised one', async () => {
    const root = await workspace();
    await init(root, { database: 'skip' });

    const result = await status(root);
    expect(result.initialised).toBe(true);
    expect(result.databaseMode).toBe('pglite');
    // Explicit timeout: this one boots a real PGlite instance, and under a full
    // parallel suite the WASM start-up alone can exceed the 5s default. A flaky
    // timeout in a green suite is worse than a slow test — it teaches people to
    // re-run instead of read.
  }, 60_000);

  it('returns null counts when no store is reachable', async () => {
    // "We could not look" and "there are none" are different answers; collapsing
    // them would let a broken daemon read as an empty project.
    const result = await status(await workspace());
    expect(result.counts.workItems).toBeNull();
  });

  it('returns real counts when a store is supplied', async () => {
    const store = { query: () => Promise.resolve([{ count: 3 }]) };
    const result = await status(await workspace(), store as never);
    expect(result.counts.workItems).toBe(3);
  });
});

describe('sequence assignment', () => {
  it('starts at 1 in an empty tree', async () => {
    expect(await nextSequence(await workspace(), 'TASK')).toBe(1);
  });

  it('continues past the highest existing id', async () => {
    const root = await workspace();
    await fs.mkdir(path.join(root, 'a'), { recursive: true });
    await fs.writeFile(path.join(root, 'a', 'TASK-007.md'), 'x');
    await fs.writeFile(path.join(root, 'a', 'TASK-002.md'), 'x');

    expect(await nextSequence(root, 'TASK')).toBe(8);
  });

  it('does not confuse prefixes', async () => {
    const root = await workspace();
    await fs.writeFile(path.join(root, 'FEAT-009.md'), 'x');
    expect(await nextSequence(root, 'TASK')).toBe(1);
  });

  it('reads the frontmatter id, not only the filename', async () => {
    // The `id` field is canonical (contract 02 §2.2); the filename slug is
    // sugar derived once and never re-derived (contract 06 §3.2). A file whose
    // name has drifted — imported, hand-created, renamed — is invisible to a
    // name-only scan, and the sequence then mints an ID that already exists.
    const root = await workspace();
    await fs.writeFile(
      path.join(root, 'notes.md'),
      '---\nid: TASK-014\ntitle: renamed by hand\n---\n',
      'utf8',
    );
    expect(await nextSequence(root, 'TASK')).toBe(15);
  });

  it('takes the highest of the two sources rather than preferring one', async () => {
    const root = await workspace();
    await fs.writeFile(path.join(root, 'TASK-020-a.md'), '---\nid: TASK-003\n---\n', 'utf8');
    expect(await nextSequence(root, 'TASK')).toBe(21);
  });
});

describe('new', () => {
  async function run(root: string, args: string[]): Promise<void> {
    await buildProgram().parseAsync(['node', 'sdlc', '-C', root, ...args]);
  }

  it('creates a valid task', async () => {
    const root = await workspace();
    await init(root, { database: 'skip' });
    await run(root, ['new', 'task', 'Add CSV export']);

    const file = path.join(root, 'kanban', '_inbox', 'TASK-001.md');
    const parsed = parseWorkItem(await fs.readFile(file, 'utf8'), file);
    expect(parsed.item.id).toBe('TASK-001');
    expect(parsed.item.title).toBe('Add CSV export');
  });

  it('places a bug on the bug ladder, not the feature one', async () => {
    const root = await workspace();
    await init(root, { database: 'skip' });
    await run(root, ['new', 'bug', 'Header row dropped']);

    const file = path.join(root, 'kanban', '_inbox', 'BUG-001.md');
    const parsed = parseWorkItem(await fs.readFile(file, 'utf8'), file);
    expect(parsed.item.lifecycle_state).toBe('triage');
  });

  it('honours the preset', async () => {
    const root = await workspace();
    await init(root, { database: 'skip' });
    await run(root, ['new', 'feature', 'Thing', '--preset', 'lite']);

    const file = path.join(root, 'kanban', '_inbox', 'FEAT-001.md');
    const parsed = parseWorkItem(await fs.readFile(file, 'utf8'), file);
    // lite/feature starts at `spec`, not `discovery`.
    expect(parsed.item.lifecycle_state).toBe('spec');
  });

  it('increments the sequence', async () => {
    const root = await workspace();
    await init(root, { database: 'skip' });
    await run(root, ['new', 'task', 'One']);
    await run(root, ['new', 'task', 'Two']);

    await expect(
      fs.stat(path.join(root, 'kanban', '_inbox', 'TASK-002.md')),
    ).resolves.toBeDefined();
  });

  it('rejects an unknown kind', async () => {
    const root = await workspace();
    await init(root, { database: 'skip' });
    await expect(run(root, ['new', 'card', 'Nope'])).rejects.toThrow(/unknown kind/);
  });
});

describe('config', () => {
  it('reports the path even when the file is missing', async () => {
    const result = await showConfig(await workspace());
    expect(result.config).toBeNull();
    expect(result.configPath).toContain('.sdlcof');
  });
});

describe('init sets up what the rest of the tool needs (v006)', () => {
  it('creates a git repository, because four commands require one', async () => {
    // Scaffolding a workspace that cannot use `branch --create`, `hooks:install`,
    // `verify` or `advance` — and saying nothing — left a first-time user to
    // find out from a refusal several commands later.
    const root = await workspace();
    const result = await init(root, { database: 'skip' });
    expect(result.initialisedGit).toBe(true);
    expect(existsSync(path.join(root, '.git'))).toBe(true);
  }, 60_000);

  it('leaves an existing repository entirely alone', async () => {
    const root = await workspace();
    await promisify(execFile)('git', ['init', '-q'], { cwd: root });
    const result = await init(root, { database: 'skip' });
    expect(result.initialisedGit).toBe(false);
  }, 60_000);
});

describe('triage retires the capture (v006)', () => {
  it('moves the capture out of the mirrored tree instead of abandoning it', async () => {
    // It used to be left in place with `kind: capture`, which the work-item
    // validator rejects — so every later `db:rebuild` reported `failed: 1` on a
    // file the tool itself created and then abandoned.
    const root = await workspace();
    await init(root, { database: 'skip' });
    const captured = await captureItem(root, 'Commas break the CSV export');
    const triaged = await triageItem(root, captured.id, 'task');

    expect(existsSync(path.join(root, captured.filePath))).toBe(false);
    expect(triaged.archivedTo).toBeDefined();
    // Moved, not deleted: the original wording is often the only record of what
    // was actually meant.
    expect(existsSync(path.join(root, triaged.archivedTo ?? ''))).toBe(true);
  }, 60_000);
});
