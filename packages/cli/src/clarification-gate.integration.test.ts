import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveWorkspaceLayout } from '@sdlc-on-fire/core';
import { afterAll, describe, expect, it } from 'vitest';
import { init } from './commands.js';
import { advanceWorkItem } from './advance.js';

/**
 * The clarification gate, on the real `advance` path (P6-SURFACE-05).
 *
 * Not against `clarificationGate` directly — that is unit-tested. The property
 * here is that the gate is actually *consulted*, which is the half that has
 * gone missing nine times in this codebase.
 */
const RM_RETRY = { maxRetries: 5, retryDelay: 100 } as const;
const madeDirs: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  madeDirs.push(dir);
  return dir;
}

afterAll(async () => {
  for (const dir of madeDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true, ...RM_RETRY }).catch(() => undefined);
  }
});

async function workspace(body: string): Promise<string> {
  const root = await fs.realpath(await tempDir('sdlcof-clarify-'));
  await init(root);
  const dir = path.join(resolveWorkspaceLayout(root).kanbanDir, '_inbox');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'FEAT-001.md'),
    [
      '---',
      'id: FEAT-001',
      'kind: feature',
      'title: CSV export',
      'status: Inbox',
      'lifecycle_state: spec',
      'preset: standard',
      'work_type: feature',
      '$schema: https://sdlc-on-fire.dev/schemas/work-item/v1.json',
      'created_at: 2026-08-24T00:00:00.000Z',
      'spec_ref: docs/specs/FEAT-001.md',
      'acceptance_criteria:',
      '  - GIVEN a range spanning DST WHEN exporting THEN every hour appears once',
      '---',
      '',
      '## Description',
      '',
      body,
      '',
    ].join('\n'),
    'utf8',
  );
  return root;
}

describe('the clarification gate blocks an advance', () => {
  it('refuses to move a card with an unresolved marker', async () => {
    // A spec with unanswered questions that reaches `plan` produces a plan built
    // on guesses, and the guesses are invisible by the time anybody reads it.
    const root = await workspace('Export rows.\n\n[NEEDS CLARIFICATION: which timezone?]');
    const result = await advanceWorkItem(root, 'FEAT-001');
    expect(result.moved).toBe(false);
    expect(result.refusals.join(' ')).toMatch(/clarification/);
    // The line, so the reader can go to it rather than search.
    // A line number, not a specific one. The property is that the reader can go
    // to it; pinning the exact line makes the test brittle against the fixture's
    // frontmatter and says nothing more.
    expect(result.refusals.join(' ')).toMatch(/line\(s\) \d+/);
  }, 180_000);

  it('says nothing about clarification when there are none', async () => {
    // The gate must not become noise on every advance — a refusal list that
    // always mentions clarification is one people stop reading.
    const root = await workspace('Export rows as CSV, in UTC.');
    const result = await advanceWorkItem(root, 'FEAT-001');
    expect(result.refusals.join(' ')).not.toMatch(/clarification/);
  }, 180_000);
});
