import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { addIntoContainer, formatAdd, readGraph, INSERTIONS_DIR } from './add.js';

/**
 * `sdlc add --into` (P2-INS-01).
 *
 * Real workspaces on disk. The core module is tested against hand-built
 * graphs; what is under test here is whether a graph read off actual
 * frontmatter produces the same answers — including the two fields the walk
 * depends on that no unit test can vouch for (`parent` vs `parent_id`, and
 * whether a claim is read as in-flight).
 */

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'add-'));
  dirs.push(root);
  await fs.mkdir(path.join(root, 'kanban', 'epics'), { recursive: true });
  return root;
}

async function card(
  root: string,
  rel: string,
  frontmatter: Record<string, unknown>,
): Promise<void> {
  const full = path.join(root, 'kanban', rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  const lines = ['---'];
  for (const [key, value] of Object.entries(frontmatter)) {
    lines.push(`${key}: ${Array.isArray(value) ? JSON.stringify(value) : String(value)}`);
  }
  lines.push('---', '', 'body', '');
  await fs.writeFile(full, lines.join('\n'), 'utf8');
}

const epic = { id: 'EPIC-001', kind: 'epic', title: 'billing', status: 'Backlog' };

describe('readGraph', () => {
  it('reads parentage from either `parent` or `parent_id`', async () => {
    // Contract 06 §3.3 renames contract 02's `parent_id` to `parent` on disk
    // and calls them one field. A reader that honours only one silently
    // produces an empty blast radius on half the corpus.
    const root = await workspace();
    await card(root, 'epics/EPIC-001/epic.md', epic);
    await card(root, 'epics/EPIC-001/a.md', { id: 'FEAT-001', parent: 'EPIC-001' });
    await card(root, 'epics/EPIC-001/b.md', { id: 'FEAT-002', parent_id: 'EPIC-001' });

    const ids = (await readGraph(path.join(root, 'kanban')))
      .filter((n) => n.parentId === 'EPIC-001')
      .map((n) => n.id);
    expect(ids.sort()).toEqual(['FEAT-001', 'FEAT-002']);
  });

  it('treats an unexpired claim as in flight', async () => {
    const root = await workspace();
    await card(root, 'epics/EPIC-001/a.md', {
      id: 'FEAT-001',
      parent: 'EPIC-001',
      claimed_by: 'dana',
      claim_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect((await readGraph(path.join(root, 'kanban')))[0]?.inFlight).toBe(true);
  });

  it('treats an expired claim as not in flight', async () => {
    const root = await workspace();
    await card(root, 'epics/EPIC-001/a.md', {
      id: 'FEAT-001',
      parent: 'EPIC-001',
      claimed_by: 'dana',
      claim_expires_at: '2020-01-01T00:00:00.000Z',
    });
    expect((await readGraph(path.join(root, 'kanban')))[0]?.inFlight).toBe(false);
  });

  it('treats an unclaimed item as not in flight', async () => {
    const root = await workspace();
    await card(root, 'epics/EPIC-001/a.md', { id: 'FEAT-001', parent: 'EPIC-001' });
    expect((await readGraph(path.join(root, 'kanban')))[0]?.inFlight).toBe(false);
  });

  it('does not read insertion records back in as work items', async () => {
    // `_insertions/` is a DB→md audit exception (contract 06 §3.5), not an md→DB
    // input. Walking it back in would make every past insertion a node in the
    // graph the next insertion is analysed against.
    const root = await workspace();
    await card(root, `${INSERTIONS_DIR}/INSERT-001.md`, { id: 'INSERT-001', kind: 'insertion' });
    expect(await readGraph(path.join(root, 'kanban'))).toEqual([]);
  });
});

describe('addIntoContainer', () => {
  it('refuses a container that does not exist', async () => {
    const root = await workspace();
    await expect(
      addIntoContainer(root, { kind: 'feature', title: 'x', into: 'EPIC-404' }),
    ).rejects.toThrow('EPIC-404');
  });

  it('lands at proposed with no approval, and writes the record anyway', async () => {
    const root = await workspace();
    await card(root, 'epics/EPIC-001/epic.md', epic);
    await card(root, 'epics/EPIC-001/a.md', { id: 'FEAT-001', parent: 'EPIC-001' });

    const result = await addIntoContainer(root, {
      kind: 'feature',
      title: 'expiring share links',
      into: 'EPIC-001',
      why: 'blocks pilot sign-off',
    });

    expect(result.state).toBe('proposed');
    const written = await fs.readFile(path.join(root, result.recordPath), 'utf8');
    expect(written).toContain('state: proposed');
    expect(written).toContain('blocks pilot sign-off');
  });

  it('puts the record where contract 06 §3.5 says', async () => {
    const root = await workspace();
    await card(root, 'epics/EPIC-001/epic.md', epic);
    const result = await addIntoContainer(root, {
      kind: 'feature',
      title: 'x',
      into: 'EPIC-001',
    });
    expect(result.recordPath).toBe(path.join('kanban', INSERTIONS_DIR, 'INSERT-001.md'));
  });

  it('reports the blast radius read off real cards', async () => {
    const root = await workspace();
    await card(root, 'epics/EPIC-001/epic.md', epic);
    await card(root, 'epics/EPIC-001/a.md', { id: 'FEAT-001', parent: 'EPIC-001' });
    await card(root, 'epics/EPIC-001/b.md', { id: 'TASK-001', parent: 'FEAT-001' });

    const result = await addIntoContainer(root, {
      kind: 'feature',
      title: 'x',
      into: 'EPIC-001',
    });
    expect(result.radius.reached.map((r) => r.id).sort()).toEqual(['FEAT-001', 'TASK-001']);
  });

  it('blocks on a real ownership conflict with claimed work', async () => {
    const root = await workspace();
    await card(root, 'epics/EPIC-001/epic.md', epic);
    await card(root, 'epics/EPIC-001/a.md', {
      id: 'FEAT-001',
      parent: 'EPIC-001',
      claimed_by: 'dana',
      claim_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      owned_paths: ['src/billing/plan.ts'],
    });

    const result = await addIntoContainer(root, {
      kind: 'feature',
      title: 'x',
      into: 'EPIC-001',
      ownedPaths: ['src/billing/plan.ts'],
    });
    expect(result.blockers.join(' ')).toContain('FEAT-001');
  });

  it('never mints its own approval', async () => {
    // There is no flag that approves an insertion. A flag on the same command
    // line that proposes it is not a second person.
    const root = await workspace();
    await card(root, 'epics/EPIC-001/epic.md', epic);
    const result = await addIntoContainer(root, {
      kind: 'feature',
      title: 'x',
      into: 'EPIC-001',
      approvals: [{ actorId: 'bot', actorKind: 'agent', roleId: 'pm', decision: 'approve' }],
    });
    expect(result.state).toBe('proposed');
  });

  it('approves on a human pm sign-off', async () => {
    const root = await workspace();
    await card(root, 'epics/EPIC-001/epic.md', epic);
    const result = await addIntoContainer(root, {
      kind: 'feature',
      title: 'x',
      into: 'EPIC-001',
      why: 'pilot',
      approvals: [{ actorId: 'dana', actorKind: 'human', roleId: 'pm', decision: 'approve' }],
    });
    expect(result.state).toBe('approved');
  });

  it('does not reuse an insertion number', async () => {
    const root = await workspace();
    await card(root, 'epics/EPIC-001/epic.md', epic);
    const first = await addIntoContainer(root, { kind: 'feature', title: 'a', into: 'EPIC-001' });
    const second = await addIntoContainer(root, { kind: 'feature', title: 'b', into: 'EPIC-001' });
    expect(first.recordId).toBe('INSERT-001');
    expect(second.recordId).toBe('INSERT-002');
  });
});

describe('formatAdd', () => {
  it('shows the blast radius before the verdict', async () => {
    const root = await workspace();
    await card(root, 'epics/EPIC-001/epic.md', epic);
    await card(root, 'epics/EPIC-001/a.md', { id: 'FEAT-001', parent: 'EPIC-001' });
    const text = formatAdd(
      await addIntoContainer(root, { kind: 'feature', title: 'x', into: 'EPIC-001' }),
    );
    expect(text.indexOf('Blast radius')).toBeLessThan(text.indexOf('Held at proposed'));
    expect(text).toContain('FEAT-001');
  });
});
