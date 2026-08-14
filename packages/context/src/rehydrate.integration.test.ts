import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chunkMarkdown } from './chunking.js';
import { rehydrate, sourcePointerFor } from './rehydrate.js';

/** P1-CTX-08 — recovering detail a summary discarded, against real files. */

const ARTIFACT = `# Retry budget

The importer retries three times.

## Backoff

Exponential, capped at 30s.

## CSV

Not supported in v0.1; the pilot customers export JSON.
`;

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'sdlcof-rehydrate-'));
  await fs.writeFile(path.join(root, 'notes.md'), ARTIFACT, 'utf8');
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function pointerToLastSection() {
  const chunks = chunkMarkdown(ARTIFACT);
  const index = chunks.length - 1;
  return sourcePointerFor({
    runId: 'run-1',
    stage: 'plan',
    artifact: 'notes.md',
    chunks,
    from: index,
    to: index,
  });
}

describe('rehydrate', () => {
  it('returns the exact content the pointer was built from', async () => {
    const result = await rehydrate(root, pointerToLastSection());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toContain('Not supported in v0.1');
    expect(result.chunks).toHaveLength(1);
  });

  it('reports drift instead of returning content that was never summarised', async () => {
    const pointer = pointerToLastSection();
    await fs.writeFile(
      path.join(root, 'notes.md'),
      ARTIFACT.replace('Not supported in v0.1', 'Supported since v0.1'),
      'utf8',
    );

    const result = await rehydrate(root, pointer);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toBe('content-changed');
    // The rewritten text is still offered — knowingly, not by accident.
    expect(result.current?.[0]?.text).toContain('Supported since v0.1');
  });

  it('reports a missing artifact rather than empty content', async () => {
    const pointer = { ...pointerToLastSection(), artifact: 'gone.md' };
    const result = await rehydrate(root, pointer);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toBe('missing-artifact');
  });

  it('reports a range that no longer exists', async () => {
    const pointer = { ...pointerToLastSection(), chunkFrom: 40, chunkTo: 41 };
    const result = await rehydrate(root, pointer);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toBe('range-out-of-bounds');
  });

  it('refuses a pointer that escapes the workspace', async () => {
    const outside = path.join(root, 'outside.md');
    await fs.writeFile(outside, '# secret\n\nnot yours\n', 'utf8');
    const nested = path.join(root, 'workspace');
    await fs.mkdir(nested, { recursive: true });

    const result = await rehydrate(nested, {
      ...pointerToLastSection(),
      artifact: '../outside.md',
    });
    // A stored pointer is data. Data does not get to name arbitrary host files.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toContain('outside the workspace');
  });

  it('is unaffected by an edit elsewhere in the same artifact', async () => {
    const pointer = pointerToLastSection();
    await fs.writeFile(
      path.join(root, 'notes.md'),
      ARTIFACT.replace('Exponential, capped at 30s.', 'Exponential, capped at 60s.'),
      'utf8',
    );
    // Hashing the whole file would call this drift; the pointer covers a range.
    const result = await rehydrate(root, pointer);
    expect(result.ok).toBe(true);
  });
});

describe('sourcePointerFor', () => {
  it('covers an inclusive range', async () => {
    const chunks = chunkMarkdown(ARTIFACT);
    const pointer = sourcePointerFor({
      runId: 'run-1',
      stage: 'plan',
      artifact: 'notes.md',
      chunks,
      from: 0,
      to: 1,
    });

    const result = await rehydrate(root, pointer);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Two chunks, not one: an exclusive `to` here would silently drop the last
    // section of every rehydrated range, and the hash would still agree with
    // itself — so only counting catches it.
    expect(result.chunks).toHaveLength(2);
    expect(result.chunks[1]?.text).toContain('Exponential');
  });
});
