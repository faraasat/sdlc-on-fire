import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { init, claimWorkItem } from './commands.js';
import { advanceWorkItem, verifyWorkItem } from './advance.js';
import { ConcurrentModificationError, versionOf, writeCardIfUnchanged } from './lifecycle-write.js';

/**
 * Compare-and-swap on lifecycle writes (P1-LIFE-04).
 *
 * A transition is read-decide-write, and everything interesting happens in the
 * gap: a second terminal, a teammate's editor, a `git checkout` landing while
 * the gate is being evaluated. A blind write at the end discards whatever
 * arrived in between, and the discarded write is the one nobody notices —
 * the file afterwards looks entirely plausible.
 */

const run = promisify(execFile);
let root: string;

const CARD = (stage: string): string =>
  [
    '---',
    '$schema: https://sdlc-on-fire.dev/schema/work-item.json',
    'id: TASK-001',
    'kind: task',
    'title: Concurrent',
    'status: In Progress',
    `lifecycle_state: ${stage}`,
    'work_type: task',
    'preset: standard',
    'risk_level: low',
    'verify: node test.js',
    'done:',
    '  - tests pass',
    'created_at: 2026-08-10T00:00:00.000Z',
    'updated_at: 2026-08-10T00:00:00.000Z',
    '---',
    '',
    'body',
    '',
  ].join('\n');

const cardPath = (): string => path.join(root, 'kanban', '_inbox', 'TASK-001.md');

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cas-')));
  await run('git', ['init', '-q'], { cwd: root });
  await run('git', ['config', 'user.email', 't@e.com'], { cwd: root });
  await run('git', ['config', 'user.name', 'T'], { cwd: root });
  await init(root);
  await fs.mkdir(path.join(root, 'kanban', '_inbox'), { recursive: true });
  await fs.writeFile(cardPath(), CARD('implement'), 'utf8');
  await fs.writeFile(path.join(root, 'package.json'), '{"name":"d","type":"module"}', 'utf8');
  await fs.writeFile(
    path.join(root, 'test.js'),
    'import assert from "node:assert"; assert.equal(1,1);',
    'utf8',
  );
}, 180_000);

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('the swap itself', () => {
  it('writes when the file still holds what was read', async () => {
    const raw = await fs.readFile(cardPath(), 'utf8');
    await writeCardIfUnchanged(cardPath(), versionOf(raw), 'new contents', 'TASK-001');
    expect(await fs.readFile(cardPath(), 'utf8')).toBe('new contents');
  }, 180_000);

  it('refuses when the file moved under it, and writes nothing', async () => {
    const raw = await fs.readFile(cardPath(), 'utf8');
    await fs.writeFile(cardPath(), CARD('test'), 'utf8'); // somebody else got there first

    await expect(
      writeCardIfUnchanged(cardPath(), versionOf(raw), 'new contents', 'TASK-001'),
    ).rejects.toBeInstanceOf(ConcurrentModificationError);
    // The other write survives intact — a refusal that still clobbered would be
    // the same bug with an error message attached.
    expect(await fs.readFile(cardPath(), 'utf8')).toBe(CARD('test'));
  }, 180_000);

  it('versions on content, not on the timestamp the card carries', () => {
    // `updated_at` is a field a writer sets, so using it as the version would
    // let a careless writer defeat the check by simply not updating it — and a
    // second-resolution timestamp cannot tell two writes in one second apart.
    const a = CARD('implement');
    const b = a.replace('lifecycle_state: implement', 'lifecycle_state: test');
    expect(versionOf(a)).not.toBe(versionOf(b));
    expect(versionOf(a)).toBe(versionOf(CARD('implement')));
  });

  it('refuses when the card was deleted rather than treating it as unchanged', async () => {
    const raw = await fs.readFile(cardPath(), 'utf8');
    await fs.rm(cardPath());
    await expect(
      writeCardIfUnchanged(cardPath(), versionOf(raw), 'new contents', 'TASK-001'),
    ).rejects.toBeInstanceOf(ConcurrentModificationError);
  }, 180_000);
});

describe('through the command', () => {
  it('refuses to apply a transition decided against a card that has since changed', async () => {
    await claimWorkItem(root, 'TASK-001', 'alice');
    await verifyWorkItem(root, 'TASK-001', { actor: 'alice' });

    // Advance reads the card, evaluates, then writes. Simulate the other writer
    // by moving the card between those points — done here by racing two
    // advances that both read the `implement` state.
    const first = advanceWorkItem(root, 'TASK-001', { actor: 'alice' });
    const second = advanceWorkItem(root, 'TASK-001', { actor: 'alice' });
    const [a, b] = await Promise.allSettled([first, second]);

    // Exactly one may have applied a transition from `implement`. The other must
    // either refuse the transition or refuse the write — never silently overwrite.
    const applied = [a, b].filter(
      (outcome) => outcome.status === 'fulfilled' && outcome.value.moved,
    );
    expect(applied.length).toBeLessThanOrEqual(1);

    // And the card is a valid single stage afterwards, not a torn write.
    const after = await fs.readFile(cardPath(), 'utf8');
    expect(after.match(/^lifecycle_state: /gm)).toHaveLength(1);
  }, 180_000);
});
