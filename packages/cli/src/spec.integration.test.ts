import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { init } from './commands.js';
import { archiveChange, checkSpecs, newChange, newSpec, splitAuthored } from './spec.js';

/**
 * `sdlc spec` / `sdlc change` against a real workspace (P4-BROWN-01).
 *
 * The grammar and the two refusals are pure and tested in core. What only this
 * can show is the round trip an author actually takes: scaffold, edit, check,
 * archive — and that the scaffolded template itself passes the validator, which
 * is the one thing a template can silently get wrong.
 */

const run = promisify(execFile);
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
const RM_RETRY = { maxRetries: 5, retryDelay: 100 } as const;

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'sdlcof-spec-'));
  await init(root, { database: 'skip' });
}, 90_000);

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true, ...RM_RETRY });
});

const write = async (relative: string, body: string): Promise<void> => {
  const full = path.join(root, 'docs', relative);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, body);
};

describe('splitAuthored', () => {
  it('shares its grammar with the OpenSpec importer', () => {
    // The premise of P4-BROWN-01 is that our native format *is* that delta
    // model. A second grammar would mean a document we wrote could fail to
    // re-import through our own parser.
    const requirements = splitAuthored(
      [
        '## ADDED Requirements',
        '',
        '### Requirement: Bounded retries',
        '',
        'The system MUST retry at most three times.',
        '',
        '- GIVEN a failing call',
        '- WHEN it is retried',
        '- THEN it stops after three',
      ].join('\n'),
    );
    expect(requirements).toHaveLength(1);
    expect(requirements[0]?.delta).toBe('ADDED');
    expect(requirements[0]?.keywords).toEqual(['MUST']);
    expect(requirements[0]?.scenarios).toHaveLength(1);
  });
});

describe('sdlc spec new', () => {
  it('scaffolds a spec that passes its own validator', async () => {
    // The one thing a template can silently get wrong: shipping an example that
    // the tool immediately refuses.
    await newSpec(root, 'billing');
    const result = await checkSpecs(root);
    expect(result.ok).toBe(true);
  });

  it('refuses to clobber an existing spec', async () => {
    await newSpec(root, 'billing');
    await write('specs/billing/spec.md', '# edited by a human\n');
    const second = await newSpec(root, 'billing');
    expect(second.created).toBe(false);
    expect(
      await fs.readFile(path.join(root, 'docs', 'specs', 'billing', 'spec.md'), 'utf8'),
    ).toContain('edited by a human');
  });
});

describe('sdlc spec check', () => {
  it('refuses a requirement with no RFC-2119 keyword', async () => {
    await write(
      'specs/billing/spec.md',
      ['### Requirement: Retries', '', 'The system handles retries nicely.'].join('\n'),
    );
    const result = await checkSpecs(root);
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.because.includes('cannot be violated'))).toBe(true);
  });

  it('refuses a scenario that cannot fail', async () => {
    await write(
      'specs/billing/spec.md',
      [
        '### Requirement: Retries',
        '',
        'It MUST retry.',
        '',
        '- GIVEN a call',
        '- WHEN it fails',
      ].join('\n'),
    );
    expect((await checkSpecs(root)).ok).toBe(false);
  });

  it('does not re-validate the archive', async () => {
    // A landed change is a historical record. Re-validating it means a rule
    // added today retroactively fails something that shipped last year, which
    // teaches people to weaken the rule rather than fix the document.
    await write(
      'changes/archive/old/proposal.md',
      '### Requirement: Ancient\n\nno keyword here.\n',
    );
    expect((await checkSpecs(root)).ok).toBe(true);
  });

  it('reports the file alongside the requirement', async () => {
    await write('specs/a/spec.md', '### Requirement: X\n\nno keyword.\n');
    const problem = (await checkSpecs(root)).problems[0];
    expect(problem?.file).toContain('specs/a/spec.md');
    expect(problem?.requirement).toBe('X');
  });

  it('says so when there is nothing to check', async () => {
    expect((await checkSpecs(root)).files).toEqual([]);
  });
});

describe('sdlc change archive', () => {
  it('moves a valid change into the archive', async () => {
    await newChange(root, 'add-retries');
    await write(
      'changes/add-retries/proposal.md',
      [
        '## ADDED Requirements',
        '',
        '### Requirement: Bounded retries',
        '',
        'The system MUST retry at most three times.',
        '',
        '- GIVEN a failing call',
        '- WHEN it is retried',
        '- THEN it stops after three',
      ].join('\n'),
    );

    const result = await archiveChange(root, 'add-retries');
    expect(result.moved).toBe(true);
    await expect(
      fs.access(path.join(root, 'docs', 'changes', 'archive', 'add-retries', 'proposal.md')),
    ).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(root, 'docs', 'changes', 'add-retries', 'proposal.md')),
    ).rejects.toThrow();
  });

  it('refuses to archive a change that does not validate', async () => {
    // Landing an invalid delta writes it into a record nothing re-validates —
    // this is the last moment the problem is cheap to fix.
    await write('changes/bad/proposal.md', '### Requirement: X\n\nno keyword.\n');
    const result = await archiveChange(root, 'bad');
    expect(result.moved).toBe(false);
    expect(result.because).toContain('does not validate');
    await expect(
      fs.access(path.join(root, 'docs', 'changes', 'bad', 'proposal.md')),
    ).resolves.toBeUndefined();
  });

  it('reports a change that does not exist rather than throwing', async () => {
    expect((await archiveChange(root, 'nope')).because).toBe('no such change');
  });

  it('keeps sibling files rather than deleting the directory', async () => {
    await write(
      'changes/keep/proposal.md',
      ['### Requirement: R', '', 'It MUST hold.', '', '- GIVEN a', '- WHEN b', '- THEN c'].join(
        '\n',
      ),
    );
    await write('changes/keep/notes.md', 'working notes\n');
    await archiveChange(root, 'keep');
    await expect(
      fs.access(path.join(root, 'docs', 'changes', 'keep', 'notes.md')),
    ).resolves.toBeUndefined();
  });

  it('runs the whole round trip on the built binary', async () => {
    await run(process.execPath, [CLI, 'spec', 'new', 'billing'], { cwd: root });
    const { stdout } = await run(process.execPath, [CLI, 'spec', 'check'], { cwd: root });
    expect(stdout).toContain('requirement(s)');
  }, 60_000);

  it('exits non-zero on the built binary when a spec is invalid', async () => {
    await write('specs/bad/spec.md', '### Requirement: X\n\nno keyword.\n');
    await expect(
      run(process.execPath, [CLI, 'spec', 'check'], { cwd: root }),
    ).rejects.toMatchObject({
      code: 1,
    });
  }, 60_000);
});
