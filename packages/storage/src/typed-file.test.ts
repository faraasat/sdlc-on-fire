import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { WorkItem } from '@sdlc-on-fire/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  parseWorkItem,
  readOnDiskStage,
  readWorkItem,
  renderWorkItem,
  TerminalItemError,
  ValidationError,
  writeWorkItem,
} from './typed-file.js';

const tempDirs: string[] = [];

async function tempFile(name = 'TASK-001.md'): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sdlcof-storage-'));
  tempDirs.push(dir);
  return path.join(dir, name);
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function task(overrides: Partial<Record<string, unknown>> = {}): WorkItem {
  return {
    $schema: 'https://sdlc-on-fire.dev/schema/work-item.json',
    id: 'TASK-001',
    kind: 'task',
    title: 'Add CSV export',
    status: 'In Progress',
    lifecycle_state: 'implement',
    work_type: 'feature',
    preset: 'standard',
    risk_level: 'low',
    created_at: '2026-08-10T00:00:00.000Z',
    updated_at: '2026-08-10T00:00:00.000Z',
    verify: 'pnpm test',
    done: ['tests pass'],
    ...overrides,
  } as unknown as WorkItem;
}

describe('parsing a work item', () => {
  it('round-trips through render and parse', () => {
    const rendered = renderWorkItem(task(), '## Notes\n\nSome body.\n');
    const parsed = parseWorkItem(rendered);
    expect(parsed.item.id).toBe('TASK-001');
    expect(parsed.body).toBe('## Notes\n\nSome body.\n');
  });

  it('carries keys the schema does not model through a rewrite', () => {
    // Zod returns only the keys it knows, so serializing its output deletes
    // everything else in the file. An ordinary `sdlc advance` was destroying
    // hand-written frontmatter in a git-tracked card, and the result parsed
    // cleanly — nothing anywhere reported a loss.
    const rendered = renderWorkItem(
      task({ owner: 'farasat', jira_ref: 'PROJ-4471' }),
      '## Notes\n\nSome body.\n',
    );
    expect(rendered).toContain('owner: farasat');
    expect(rendered).toContain('jira_ref: PROJ-4471');
  });

  it('reports schema violations with field paths', () => {
    // status disagrees with lifecycle_state — a cross-field invariant.
    const bad = renderWorkItem.bind(null, task({ status: 'Done' }), 'body');
    expect(bad).toThrow(ValidationError);
    try {
      bad();
    } catch (error) {
      expect((error as ValidationError).issues.join()).toContain('status');
    }
  });

  it('rejects a file whose frontmatter is not a work item', () => {
    expect(() => parseWorkItem('---\ntitle: not a work item\n---\nbody\n')).toThrow(
      ValidationError,
    );
  });
});

describe('writing', () => {
  it('creates parent directories', async () => {
    const target = path.join(path.dirname(await tempFile()), 'kanban', 'epics', 'e', 'TASK-001.md');
    await writeWorkItem(target, task(), 'body\n');
    await expect(fs.stat(target)).resolves.toBeDefined();
  });

  it('writes canonical bytes', async () => {
    const target = await tempFile();
    await writeWorkItem(target, task(), 'body\n');
    const raw = await fs.readFile(target, 'utf8');

    // Canonical order: id before title before updated_at.
    expect(raw.indexOf('\nid:')).toBeLessThan(raw.indexOf('\ntitle:'));
    expect(raw.indexOf('\ntitle:')).toBeLessThan(raw.indexOf('\nupdated_at:'));
  });

  it('is byte-stable across repeated writes of the same item', async () => {
    const target = await tempFile();
    await writeWorkItem(target, task(), 'body\n');
    const first = await fs.readFile(target, 'utf8');
    await writeWorkItem(target, task(), 'body\n');
    expect(await fs.readFile(target, 'utf8')).toBe(first);
  });

  it('produces a one-line diff for a one-field change', async () => {
    const target = await tempFile();
    await writeWorkItem(target, task(), 'body\n');
    const before = (await fs.readFile(target, 'utf8')).split('\n');

    await writeWorkItem(target, task({ title: 'Renamed' }), 'body\n');
    const after = (await fs.readFile(target, 'utf8')).split('\n');

    const changed = before.filter((line, index) => line !== after[index]);
    expect(changed).toHaveLength(1);
    expect(changed[0]).toContain('title:');
  });

  it('refuses to write an item that fails validation', async () => {
    const target = await tempFile();
    await expect(writeWorkItem(target, task({ verify: '' }), 'body')).rejects.toBeInstanceOf(
      ValidationError,
    );
    // Nothing was written.
    await expect(fs.stat(target)).rejects.toThrow();
  });

  it('carries unmodelled keys to disk, not just through render', async () => {
    // `renderWorkItem` and `writeWorkItem` validate separately and serialize
    // separately, so fixing one leaves the other still deleting the file's
    // hand-written fields — and this is the path that actually touches disk.
    const target = await tempFile();
    await writeWorkItem(target, task({ owner: 'farasat', jira_ref: 'PROJ-4471' }), 'body\n');
    const raw = await fs.readFile(target, 'utf8');
    expect(raw).toContain('owner: farasat');
    expect(raw).toContain('jira_ref: PROJ-4471');
  });

  it('reads back what it wrote', async () => {
    const target = await tempFile();
    await writeWorkItem(target, task(), '## Notes\n');
    const { item, body } = await readWorkItem(target);
    expect(item.title).toBe('Add CSV export');
    expect(body).toBe('## Notes\n');
  });
});

describe('terminal-item immutability (ADR-0013)', () => {
  it('refuses an in-place edit of a done item', async () => {
    const target = await tempFile();
    await writeWorkItem(target, task({ lifecycle_state: 'done', status: 'Done' }), 'body\n');

    await expect(
      writeWorkItem(
        target,
        task({ title: 'Sneaky edit', lifecycle_state: 'done', status: 'Done' }),
        'body\n',
      ),
    ).rejects.toBeInstanceOf(TerminalItemError);
  });

  it('checks the on-disk stage, not the incoming one', async () => {
    const target = await tempFile();
    await writeWorkItem(target, task({ lifecycle_state: 'done', status: 'Done' }), 'body\n');

    // An agent claiming the item is back at `implement` must not thereby unlock it.
    await expect(writeWorkItem(target, task(), 'body\n')).rejects.toBeInstanceOf(TerminalItemError);
  });

  describe('the selective gate re-open (P2-INS-02, contract 02 §8 q2)', () => {
    const authorization = {
      kind: 'insertion' as const,
      insertionId: 'INSERT-014',
      insertionState: 'approved',
      blastRadius: ['TASK-001'],
      itemId: 'TASK-001',
    };

    async function finished(): Promise<string> {
      const target = await tempFile();
      await writeWorkItem(target, task({ lifecycle_state: 'done', status: 'Done' }), 'body\n');
      return target;
    }

    it('allows a re-open that only moves gate state', async () => {
      const target = await finished();
      await expect(
        writeWorkItem(target, task({ lifecycle_state: 'review', status: 'Review' }), 'body\n', {
          reopen: authorization,
        }),
      ).resolves.toBeUndefined();
    });

    it('refuses a re-open that rewrites content', async () => {
      // The whole reason the old `allowTerminal: boolean` had to go. A caller
      // that can pass a flag can pass it alongside any diff at all; a caller
      // that must pass an authorization still cannot smuggle a content edit
      // through it.
      const target = await finished();
      await expect(
        writeWorkItem(
          target,
          task({ lifecycle_state: 'review', status: 'Review', title: 'Rewritten' }),
          'body\n',
          { reopen: authorization },
        ),
      ).rejects.toBeInstanceOf(TerminalItemError);
    });

    it('refuses a re-open that rewrites the body', async () => {
      const target = await finished();
      await expect(
        writeWorkItem(target, task({ lifecycle_state: 'review', status: 'Review' }), 'other\n', {
          reopen: authorization,
        }),
      ).rejects.toBeInstanceOf(TerminalItemError);
    });

    it('refuses a re-open whose insertion was never approved', async () => {
      const target = await finished();
      await expect(
        writeWorkItem(target, task({ lifecycle_state: 'review', status: 'Review' }), 'body\n', {
          reopen: { ...authorization, insertionState: 'proposed' },
        }),
      ).rejects.toBeInstanceOf(TerminalItemError);
    });

    it('refuses a re-open for an item outside the blast radius', async () => {
      const target = await finished();
      await expect(
        writeWorkItem(target, task({ lifecycle_state: 'review', status: 'Review' }), 'body\n', {
          reopen: { ...authorization, blastRadius: ['STORY-999'] },
        }),
      ).rejects.toBeInstanceOf(TerminalItemError);
    });

    it('says why the offered re-open did not hold', async () => {
      const target = await finished();
      await expect(
        writeWorkItem(
          target,
          task({ lifecycle_state: 'review', status: 'Review', title: 'Rewritten' }),
          'body\n',
          { reopen: { ...authorization, insertionState: 'proposed' } },
        ),
      ).rejects.toThrow(/not an authority[\s\S]*not re-openable/);
    });

    it('compares against the file on disk, not the caller’s account of it', async () => {
      // The same discipline as the terminal check itself: an agent that hands
      // over a "before" of its own devising must not thereby define what
      // counts as unchanged.
      const target = await finished();
      await fs.writeFile(
        target,
        '---\nid: TASK-001\nlifecycle_state: done\ntitle: On disk\n---\nreal body\n',
        'utf8',
      );
      await expect(
        writeWorkItem(target, task({ lifecycle_state: 'review', status: 'Review' }), 'body\n', {
          reopen: authorization,
        }),
      ).rejects.toBeInstanceOf(TerminalItemError);
    });
  });

  it('permits editing a non-terminal item', async () => {
    const target = await tempFile();
    await writeWorkItem(target, task(), 'body\n');
    await expect(writeWorkItem(target, task({ title: 'Fine' }), 'body\n')).resolves.toBeUndefined();
  });

  it('treats a missing file as writable', async () => {
    expect(await readOnDiskStage(await tempFile())).toBeNull();
  });

  it('blocks on a terminal stage even when the rest of the file is now invalid', async () => {
    // A schema change must not quietly unlock items finished under an older one.
    const target = await tempFile();
    await fs.writeFile(target, '---\nlifecycle_state: done\nnonsense: true\n---\nbody\n');
    await expect(writeWorkItem(target, task(), 'body\n')).rejects.toBeInstanceOf(TerminalItemError);
  });
});
