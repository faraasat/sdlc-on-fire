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

  it('allows the daemon selective-reopen escape hatch', async () => {
    const target = await tempFile();
    await writeWorkItem(target, task({ lifecycle_state: 'done', status: 'Done' }), 'body\n');

    await expect(
      writeWorkItem(target, task(), 'body\n', { allowTerminal: true }),
    ).resolves.toBeUndefined();
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
