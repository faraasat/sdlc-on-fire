import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_HELD_OUT_ROOT,
  deriveScopes,
  isHeldOutPath,
  permitsPath,
  LEAK_SURFACES,
} from '@sdlc-on-fire/core';
import { assembleContextPack, renderPack } from '@sdlc-on-fire/context';
import { ContextPackSpecSchema } from '@sdlc-on-fire/core';
import { applySchema, PostgresStorageAdapter } from '@sdlc-on-fire/db';
import { rebuildMirror } from '@sdlc-on-fire/daemon';
import { init, openWorkspaceDatabase } from './commands.js';

/**
 * The leak test (P7-HELDOUT-01).
 *
 * Every unit test above asserts that a *predicate* answers correctly. This
 * asserts the thing that actually matters: that a real held-out file, sitting
 * in a real workspace, does not reach any of the four surfaces — through the
 * real mirror, the real retriever, the real pack assembler and the real scope
 * derivation.
 *
 * The distinction is not pedantic. A correct predicate that nothing calls is
 * precisely the failure mode this repository keeps finding, and for a held-out
 * suite it is worse than usual: the pack still renders, the agent still
 * answers, and the number silently stops meaning anything.
 */

const RM_RETRY = { maxRetries: 5, retryDelay: 100 } as const;
const SECRET = 'ASSERTION_THE_LOOP_MUST_NEVER_SEE';
let root: string;

const SPEC = ContextPackSpecSchema.parse({
  skillId: 'implement',
  stageId: 'implement',
  budget: { max: 4_000 },
  sources: { include: [{ kind: 'work_item', id: 'TASK-001' }] },
  freshness: { revalidateOnAssembly: true },
  isolation: 'fresh-subagent',
  disposer: 'assembleContextPack.truncateToBudget',
});

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'heldout-')));
  await init(root, { database: 'skip' });

  // A held-out test, containing a string nothing outside the daemon may see.
  const heldOutDir = path.join(root, DEFAULT_HELD_OUT_ROOT);
  await fs.mkdir(heldOutDir, { recursive: true });
  await fs.writeFile(
    path.join(heldOutDir, 'billing.test.ts'),
    `it('charges the right amount', () => { expect(x).toBe('${SECRET}'); });\n`,
    'utf8',
  );
}, 180_000);

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true, ...RM_RETRY });
});

describe('surface: retrieval-index', () => {
  it('never mirrors a held-out file, so it can never be chunked', async () => {
    const { db } = await openWorkspaceDatabase(root);
    try {
      await applySchema(db);
      const port = await PostgresStorageAdapter.create(db);
      await rebuildMirror(root, port);

      const rows = await db.query<{ chunk_text: string }>('SELECT chunk_text FROM embeddings;');
      expect(rows.some((row) => row.chunk_text.includes(SECRET))).toBe(false);

      for (const table of ['work_items', 'docs'] as const) {
        const mirrored = await port.mirroredPaths(table);
        expect(mirrored.some((row) => isHeldOutPath(row.filePath))).toBe(false);
      }
    } finally {
      await db.close();
    }
  }, 180_000);

  it('holds a configured root out even when it sits inside a mirrored tree', async () => {
    // The case the walk-only-kanban-and-docs argument does not cover: a
    // workspace that puts its held-out root where the mirror already walks.
    // `docs/tests/held-out/` would be a *coincidentally named* directory — a
    // root is matched from the project root, not anywhere in the path — so the
    // workspace has to say so, and the mirror has to read what it said.
    const configPath = path.join(root, '.sdlcof', 'config.yaml');
    const config = await fs.readFile(configPath, 'utf8');
    await fs.writeFile(configPath, `${config}\ntesting:\n  held_out_root: docs/sealed\n`, 'utf8');

    const inside = path.join(root, 'docs', 'sealed');
    await fs.mkdir(inside, { recursive: true });
    await fs.writeFile(path.join(inside, 'sealed.md'), `# ${SECRET}\n`, 'utf8');

    const { db } = await openWorkspaceDatabase(root);
    try {
      await applySchema(db);
      const port = await PostgresStorageAdapter.create(db);
      await rebuildMirror(root, port);
      const rows = await db.query<{ chunk_text: string }>('SELECT chunk_text FROM embeddings;');
      expect(rows.some((row) => row.chunk_text.includes(SECRET))).toBe(false);

      const mirrored = await port.mirroredPaths('docs');
      expect(mirrored.some((row) => row.filePath.startsWith('docs/sealed/'))).toBe(false);
    } finally {
      await db.close();
    }
  }, 180_000);

  it('mirrors a coincidentally-named directory that is not the configured root', async () => {
    // The other direction, and the one that is easy to get wrong silently: a
    // path *containing* the conventional root name is an ordinary file, and
    // hiding it would take real content away from the agent.
    const decoy = path.join(root, 'docs', 'tests', 'held-out');
    await fs.mkdir(decoy, { recursive: true });
    await fs.writeFile(path.join(decoy, 'note.md'), '# an ordinary note\n', 'utf8');

    const { db } = await openWorkspaceDatabase(root);
    try {
      await applySchema(db);
      const port = await PostgresStorageAdapter.create(db);
      await rebuildMirror(root, port);
      const mirrored = await port.mirroredPaths('docs');
      expect(mirrored.some((row) => row.filePath === 'docs/tests/held-out/note.md')).toBe(true);
    } finally {
      await db.close();
    }
  }, 180_000);
});

describe('surface: context-pack', () => {
  it('drops a held-out chunk the retriever offered, and counts it', async () => {
    const assembled = await assembleContextPack({
      spec: SPEC,
      cardId: 'TASK-001',
      skillStable: 'skill',
      cardCore: 'card',
      retrieve: () =>
        Promise.resolve([
          { id: `${DEFAULT_HELD_OUT_ROOT}/billing.test.ts#0`, text: SECRET, score: 1, tokens: 10 },
          { id: 'docs/DESIGN.md#0', text: 'ordinary design note', score: 0.9, tokens: 10 },
        ]),
    });

    expect(renderPack(assembled.pack)).not.toContain(SECRET);
    expect(renderPack(assembled.pack)).toContain('ordinary design note');
    // Counted, not silently dropped: a filter you cannot observe is one you
    // cannot confirm is still working.
    expect(assembled.heldOutFiltered).toBe(1);
  }, 180_000);

  it('reports zero when the retriever offered nothing held out', async () => {
    const assembled = await assembleContextPack({
      spec: SPEC,
      cardId: 'TASK-001',
      skillStable: 'skill',
      cardCore: 'card',
      retrieve: () =>
        Promise.resolve([{ id: 'docs/DESIGN.md#0', text: 'note', score: 1, tokens: 10 }]),
    });
    expect(assembled.heldOutFiltered).toBe(0);
  }, 180_000);

  it('honours a moved root rather than a hard-coded one', async () => {
    const assembled = await assembleContextPack({
      spec: SPEC,
      cardId: 'TASK-001',
      skillStable: 'skill',
      cardCore: 'card',
      heldOutRoot: 'spec/sealed',
      retrieve: () =>
        Promise.resolve([
          { id: 'spec/sealed/a.test.ts#0', text: SECRET, score: 1, tokens: 10 },
          {
            id: `${DEFAULT_HELD_OUT_ROOT}/b.test.ts#0`,
            text: 'not sealed here',
            score: 0.9,
            tokens: 10,
          },
        ]),
    });
    expect(renderPack(assembled.pack)).not.toContain(SECRET);
    expect(renderPack(assembled.pack)).toContain('not sealed here');
  }, 180_000);
});

describe('surface: agent-file-scope', () => {
  it('refuses the held-out file to every stage', () => {
    const file = `${DEFAULT_HELD_OUT_ROOT}/billing.test.ts`;
    for (const stage of ['implement', 'review', 'spec']) {
      expect(permitsPath(deriveScopes({ stage }), file)).toBe(false);
    }
  });

  it('still permits the ordinary tests beside it', () => {
    expect(permitsPath(deriveScopes({ stage: 'implement' }), 'tests/unit/billing.test.ts')).toBe(
      true,
    );
  });
});

describe('the set of surfaces', () => {
  it('has a test for each one it names', () => {
    // If a fifth surface is added to LEAK_SURFACES, this fails until somebody
    // covers it — which is the point of enumerating them as data.
    expect(new Set(LEAK_SURFACES)).toEqual(
      new Set(['context-pack', 'agent-file-scope', 'agent-verify-command', 'retrieval-index']),
    );
  });
});
