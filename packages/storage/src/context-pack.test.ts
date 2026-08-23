import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { persistContextPack, readContextPack } from './context-pack.js';
import { contextPackPath } from '@sdlc-on-fire/core';

const roots: string[] = [];
async function root(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sdlcof-pack-'));
  roots.push(dir);
  return dir;
}
afterAll(async () => {
  for (const dir of roots) await fs.rm(dir, { recursive: true, force: true });
});

describe('contextPackPath', () => {
  it('matches the convention the run schema already documented', () => {
    expect(contextPackPath('run-1')).toBe('.sdlc/context/packs/run-1.md');
  });

  it('is relative, because the value is read on another machine', () => {
    expect(path.isAbsolute(contextPackPath('run-1'))).toBe(false);
  });

  it('refuses a run id that would escape the packs directory', () => {
    // A `..` silently redirects the write, and an audit copy written somewhere
    // other than where the record says it is beats having none only in theory.
    expect(() => contextPackPath('../../etc/passwd')).toThrow(/unsafe run id/);
    expect(() => contextPackPath('a/b')).toThrow(/unsafe run id/);
    expect(() => contextPackPath('')).toThrow(/unsafe run id/);
  });

  it('accepts ordinary ids', () => {
    expect(() => contextPackPath('run_2026-08-23.1')).not.toThrow();
  });
});

describe('persistContextPack', () => {
  it('writes the pack where the path says it is', async () => {
    const dir = await root();
    const result = await persistContextPack(dir, 'run-1', '# pack\nhello');
    expect(result.written).toBe(true);
    expect(await fs.readFile(path.join(dir, result.relativePath), 'utf8')).toBe('# pack\nhello');
  });

  it('creates the directory rather than requiring one', async () => {
    const dir = await root();
    await expect(persistContextPack(dir, 'run-1', 'x')).resolves.toMatchObject({ written: true });
  });

  it('never overwrites an existing pack', async () => {
    // The pack on disk is evidence of what was actually sent. Rewriting it
    // makes the record disagree with what happened, in the direction of
    // whatever ran most recently.
    const dir = await root();
    await persistContextPack(dir, 'run-1', 'original');
    const second = await persistContextPack(dir, 'run-1', 'REPLACED');
    expect(second.written).toBe(false);
    expect(await readContextPack(dir, 'run-1')).toBe('original');
  });

  it('reports the same path whether it wrote or not', async () => {
    const dir = await root();
    const first = await persistContextPack(dir, 'run-1', 'a');
    const second = await persistContextPack(dir, 'run-1', 'b');
    expect(second.relativePath).toBe(first.relativePath);
  });

  it('keeps packs for different runs apart', async () => {
    const dir = await root();
    await persistContextPack(dir, 'run-1', 'one');
    await persistContextPack(dir, 'run-2', 'two');
    expect(await readContextPack(dir, 'run-1')).toBe('one');
    expect(await readContextPack(dir, 'run-2')).toBe('two');
  });

  it('rethrows a real filesystem failure rather than reporting a quiet no-op', async () => {
    // EEXIST means "already recorded" and is fine. Anything else means the
    // audit copy did not happen, and swallowing it would leave a run pointing
    // at a file that is not there.
    const dir = await root();
    const packs = path.join(dir, '.sdlc', 'context', 'packs');
    await fs.mkdir(packs, { recursive: true });
    await fs.chmod(packs, 0o500);
    try {
      await expect(persistContextPack(dir, 'run-9', 'x')).rejects.toThrow();
    } finally {
      await fs.chmod(packs, 0o700);
    }
  });
});

describe('readContextPack', () => {
  it('returns null for a run that has no pack', async () => {
    expect(await readContextPack(await root(), 'run-missing')).toBeNull();
  });
});
