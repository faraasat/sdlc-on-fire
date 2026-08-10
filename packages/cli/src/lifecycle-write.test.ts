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
  it('does not eat frontmatter it does not model', async () => {
    // Found by walking the v0.1 DoD by hand, not by any test: `sdlc advance`
    // serialized Zod's parsed output, which contains only the keys the schema
    // knows — so every other key in a git-tracked card was deleted by an
    // ordinary transition, and the result parsed cleanly.
    await fs.writeFile(
      cardPath(),
      CARD('implement').replace('verify: node test.js', 'verify: node test.js\nowner: farasat'),
      'utf8',
    );
    await claimWorkItem(root, 'TASK-001', 'alice');
    await verifyWorkItem(root, 'TASK-001', { actor: 'alice' });
    await advanceWorkItem(root, 'TASK-001', { actor: 'alice' });

    const after = await fs.readFile(cardPath(), 'utf8');
    expect(after).toContain('owner: farasat');
    // `verify:` is modelled on tasks but not features, so on a feature card the
    // transition deleted the command — and the next gate then refused the item
    // for "declares no `verify:` command", naming a field the tool had removed.
    expect(after).toContain('verify: node test.js');
  }, 180_000);

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

describe('Definition of Ready at the boundary (P1-GATE-07, ADR-0031)', () => {
  // Each preset's ladder differs, so the card starts wherever a readiness stage
  // is actually next — the gate fires on the way *into* planning and
  // implementation, not at an arbitrary stage.
  const VAGUE = (preset: string, stage: string): string =>
    [
      '---',
      '$schema: https://sdlc-on-fire.dev/schema/work-item.json',
      'id: TASK-001',
      'kind: feature',
      'title: Vague',
      'status: In Progress',
      `lifecycle_state: ${stage}`,
      'work_type: feature',
      `preset: ${preset}`,
      'risk_level: low',
      'verify: node test.js',
      'done:',
      '  - it should probably work',
      'created_at: 2026-08-10T00:00:00.000Z',
      'updated_at: 2026-08-10T00:00:00.000Z',
      '---',
      '',
      'body',
      '',
    ].join('\n');

  it('reports findings without adding a refusal under standard', async () => {
    await fs.writeFile(cardPath(), VAGUE('standard', 'plan'), 'utf8');
    const result = await advanceWorkItem(root, 'TASK-001', { actor: 'ana' });

    // Soft: the reader is told what was under-specified, and readiness itself
    // adds nothing to the refusal list. Other guards may still refuse — that is
    // their business, not this gate's.
    expect(result.readiness?.join(' ')).toContain('non-goals-present');
    expect(result.readiness?.join(' ')).toContain('acceptance-criteria-scored');
    expect(result.refusals.filter((reason) => reason.startsWith('ready:'))).toEqual([]);
  }, 60_000);

  it('adds a refusal under strict, where the workspace asked for it', async () => {
    await fs.writeFile(cardPath(), VAGUE('strict', 'plan'), 'utf8');
    const result = await advanceWorkItem(root, 'TASK-001', { actor: 'ana' });

    expect(result.moved).toBe(false);
    expect(result.refusals.some((reason) => reason.startsWith('ready:'))).toBe(true);
  }, 60_000);

  it('lets a real reason lift the strict refusal', async () => {
    await fs.writeFile(cardPath(), VAGUE('strict', 'plan'), 'utf8');
    const result = await advanceWorkItem(root, 'TASK-001', {
      actor: 'ana',
      readinessOverride: 'the scope is fixed by a contract we already signed',
    });

    expect(result.refusals.filter((reason) => reason.startsWith('ready:'))).toEqual([]);
    // Overridden, not erased — the findings still travel with the result.
    expect(result.readiness?.length ?? 0).toBeGreaterThan(0);
  }, 60_000);

  it('does not accept a gesture as an override', async () => {
    await fs.writeFile(cardPath(), VAGUE('strict', 'plan'), 'utf8');
    const result = await advanceWorkItem(root, 'TASK-001', {
      actor: 'ana',
      readinessOverride: 'ok',
    });

    expect(result.refusals.join(' ')).toContain('not a gesture');
  }, 60_000);

  it('does not evaluate readiness at stages that are not entry points', async () => {
    await fs.writeFile(cardPath(), VAGUE('standard', 'implement'), 'utf8');
    const result = await advanceWorkItem(root, 'TASK-001', { actor: 'ana' });
    // Asking at `test` whether the spec was well-formed is a retrospective,
    // not a gate.
    expect(result.readiness).toBeUndefined();
  }, 60_000);
});
