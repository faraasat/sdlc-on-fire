import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { addIntoContainer } from './add.js';
import { formatReopen, radiusFromRecord, reopenGates, UnapprovedInsertionError } from './reopen.js';

/**
 * `sdlc reopen` (P2-INS-02).
 *
 * Driven through real insertion records written by `sdlc add`, not
 * hand-authored fixtures — the record format is a seam between two commands,
 * and a fixture would only prove the reader agrees with my memory of the
 * writer.
 */

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function workspaceWithInsertion(
  approvals: Parameters<typeof addIntoContainer>[1]['approvals'] = [],
): Promise<{ root: string; insertionId: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'reopen-'));
  dirs.push(root);
  const dir = path.join(root, 'kanban', 'epics', 'EPIC-001');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'epic.md'),
    '---\nid: EPIC-001\nkind: epic\ntitle: billing\n---\n',
    'utf8',
  );
  await fs.writeFile(
    path.join(dir, 'story.md'),
    '---\nid: STORY-001\nparent: EPIC-001\ntitle: metering\n---\n',
    'utf8',
  );

  const result = await addIntoContainer(root, {
    kind: 'feature',
    title: 'prorated refunds',
    into: 'EPIC-001',
    why: 'regulator deadline',
    ...(approvals === undefined ? {} : { approvals }),
  });
  return { root, insertionId: result.recordId };
}

const pm = [
  { actorId: 'dana', actorKind: 'human' as const, roleId: 'pm', decision: 'approve' as const },
];

describe('reopenGates', () => {
  it('refuses an insertion that was never approved', async () => {
    // The authority to re-open gates on finished work comes from an approved
    // rescope. A command that re-opened for any diff would be a way around the
    // approval rather than a consequence of it.
    const { root, insertionId } = await workspaceWithInsertion();
    await expect(
      reopenGates(root, { insertionId, changed: ['src/a.ts'], requirements: ['unit-tests'] }),
    ).rejects.toBeInstanceOf(UnapprovedInsertionError);
  });

  it('refuses an insertion record that does not exist', async () => {
    const { root } = await workspaceWithInsertion(pm);
    await expect(
      reopenGates(root, { insertionId: 'INSERT-404', changed: [], requirements: [] }),
    ).rejects.toThrow('INSERT-404');
  });

  it('plans against an approved insertion', async () => {
    const { root, insertionId } = await workspaceWithInsertion(pm);
    const result = await reopenGates(root, {
      insertionId,
      changed: ['src/export/csv.ts'],
      requirements: ['unit-tests', 'ui-review'],
      coverage: [
        { requirementId: 'unit-tests', paths: ['src/'] },
        { requirementId: 'ui-review', paths: ['app/'] },
      ],
    });
    expect(result.plan.reopened).toEqual(['unit-tests']);
    expect(result.plan.kept).toEqual(['ui-review']);
  });

  it('writes nothing without --apply', async () => {
    const { root, insertionId } = await workspaceWithInsertion(pm);
    const before = await fs.readFile(
      path.join(root, 'kanban', '_insertions', `${insertionId}.md`),
      'utf8',
    );
    await reopenGates(root, {
      insertionId,
      changed: ['src/a.ts'],
      requirements: ['unit-tests'],
    });
    expect(
      await fs.readFile(path.join(root, 'kanban', '_insertions', `${insertionId}.md`), 'utf8'),
    ).toBe(before);
  });

  it('appends the audit section with --apply, leaving the original intact', async () => {
    // An audit trail edited in place is the failure this subsystem exists to
    // prevent, committed against its own evidence.
    const { root, insertionId } = await workspaceWithInsertion(pm);
    const recordPath = path.join(root, 'kanban', '_insertions', `${insertionId}.md`);
    const before = await fs.readFile(recordPath, 'utf8');

    await reopenGates(root, {
      insertionId,
      changed: ['src/export/csv.ts'],
      requirements: ['unit-tests'],
      coverage: [{ requirementId: 'unit-tests', paths: ['src/'] }],
      apply: true,
    });

    const after = await fs.readFile(recordPath, 'utf8');
    expect(after.startsWith(before)).toBe(true);
    expect(after).toContain('## Gate re-open');
    expect(after).toContain('**re-opened** `unit-tests`');
  });

  it('records gates left standing as well as gates re-opened', async () => {
    // A record naming only what re-opened cannot distinguish a gate
    // deliberately kept from one nobody considered.
    const { root, insertionId } = await workspaceWithInsertion(pm);
    await reopenGates(root, {
      insertionId,
      changed: ['src/export/csv.ts'],
      requirements: ['unit-tests', 'ui-review'],
      coverage: [
        { requirementId: 'unit-tests', paths: ['src/'] },
        { requirementId: 'ui-review', paths: ['app/'] },
      ],
      apply: true,
    });
    const after = await fs.readFile(
      path.join(root, 'kanban', '_insertions', `${insertionId}.md`),
      'utf8',
    );
    expect(after).toContain('left standing `ui-review`');
  });

  it('re-opens everything on a migrate regardless of coverage', async () => {
    const { root, insertionId } = await workspaceWithInsertion(pm);
    const result = await reopenGates(root, {
      insertionId,
      changed: ['src/export/csv.ts'],
      requirements: ['ui-review'],
      coverage: [{ requirementId: 'ui-review', paths: ['app/'] }],
      workType: 'migrate',
    });
    expect(result.plan.reopened).toEqual(['ui-review']);
  });
});

describe('radiusFromRecord', () => {
  it('reads the blast radius back out of the record it was written into', async () => {
    const { root, insertionId } = await workspaceWithInsertion(pm);
    const result = await reopenGates(root, {
      insertionId,
      changed: [],
      requirements: [],
    });
    expect(result.blastRadius).toEqual(['STORY-001']);
  });

  it('returns nothing for a record with no radius section', () => {
    expect(radiusFromRecord('# INSERT-001\n\nnothing here\n')).toEqual([]);
  });

  it('stops at the next section rather than swallowing the whole file', () => {
    const body = [
      '## Blast radius',
      '',
      '- STORY-001 (1 hop)',
      '',
      '## Blocked by',
      '',
      '- FEAT-999 something',
      '',
    ].join('\n');
    expect(radiusFromRecord(body)).toEqual(['STORY-001']);
  });
});

describe('formatReopen', () => {
  it('names the insertion and each decision', async () => {
    const { root, insertionId } = await workspaceWithInsertion(pm);
    const text = formatReopen(
      await reopenGates(root, {
        insertionId,
        changed: ['src/a.ts'],
        requirements: ['unit-tests'],
      }),
    );
    expect(text).toContain(insertionId);
    expect(text).toContain('unit-tests');
  });
});
