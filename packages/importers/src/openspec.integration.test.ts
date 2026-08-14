import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OpenSpecParser, splitRequirements, splitTasks } from './openspec.js';
import { planImport } from './writer.js';
import { createHash } from 'node:crypto';

/**
 * Teardown retries, because Windows keeps a file locked while anything holds it.
 *
 * A child process that has just exited can still own its handles for a moment,
 * and removing the directory then fails with EBUSY — which Vitest reports as a
 * failed suite even though every assertion in it passed. Retrying is the
 * documented remedy, and is a no-op on platforms without the problem.
 */
const RM_RETRY = { maxRetries: 5, retryDelay: 100 } as const;

/**
 * P2-IMP-03 — the OpenSpec parser, against a real directory tree.
 *
 * The formats are quoted from `.research/10 §2.3`, which verified them against
 * the upstream docs. Building the tree on disk rather than stubbing `fs` is the
 * point: a parser's real failures are missing files, empty directories and
 * files that do not contain what their name implies, and a stubbed filesystem
 * has none of those.
 */

const dirs: string[] = [];
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true, ...RM_RETRY })),
  );
});

const SPEC = `# Auth

### Requirement: User Authentication
The system SHALL issue a JWT token upon successful login.

#### Scenario: Valid credentials
- GIVEN a user with valid credentials
- WHEN the user submits login form
- THEN a JWT token is returned

### Requirement: Session Expiration
The system MUST expire sessions after 30 minutes.
`;

const DELTA = `## ADDED Requirements

### Requirement: Two-Factor Authentication
The system MUST support TOTP-based two-factor authentication.

## REMOVED Requirements

### Requirement: Remember Me
(Deprecated in favor of 2FA.)
`;

async function tree(over: { archived?: boolean } = {}): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'openspec-'));
  dirs.push(root);
  const base = path.join(root, 'openspec');

  await fs.mkdir(path.join(base, 'specs', 'auth'), { recursive: true });
  await fs.writeFile(path.join(base, 'specs', 'auth', 'spec.md'), SPEC, 'utf8');

  const changeDir =
    over.archived === true
      ? path.join(base, 'changes', 'archive', '2026-01-01-add-2fa')
      : path.join(base, 'changes', 'add-2fa');
  await fs.mkdir(path.join(changeDir, 'specs', 'auth'), { recursive: true });
  await fs.writeFile(path.join(changeDir, 'proposal.md'), '# Add 2FA\n\nBecause.\n', 'utf8');
  await fs.writeFile(path.join(changeDir, 'design.md'), 'Use TOTP.\n', 'utf8');
  await fs.writeFile(
    path.join(changeDir, 'tasks.md'),
    '- [x] Add TOTP library\n- [ ] Wire enrollment UI\n',
    'utf8',
  );
  await fs.writeFile(path.join(changeDir, 'specs', 'auth', 'spec.md'), DELTA, 'utf8');
  return root;
}

describe('splitRequirements', () => {
  it('splits a current-state spec into its requirements', () => {
    const requirements = splitRequirements(SPEC);
    expect(requirements.map((r) => r.title)).toEqual(['User Authentication', 'Session Expiration']);
    expect(requirements[0]?.body).toContain('GIVEN a user with valid credentials');
  });

  it('carries the delta verb down onto every requirement beneath it', () => {
    const requirements = splitRequirements(DELTA);
    // The verb lives on a `##` header above a run of `###` requirements. A
    // parser that read requirements alone would turn a REMOVED requirement into
    // a newly-imported one — the exact inversion of what the source says.
    expect(requirements.map((r) => [r.title, r.delta])).toEqual([
      ['Two-Factor Authentication', 'ADDED'],
      ['Remember Me', 'REMOVED'],
    ]);
  });

  it('leaves delta undefined on a current-state spec', () => {
    expect(splitRequirements(SPEC).every((r) => r.delta === undefined)).toBe(true);
  });
});

describe('splitTasks', () => {
  it('reads the checklist and its checked state', () => {
    expect(splitTasks('- [x] done thing\n- [ ] pending thing\nnot a task\n')).toEqual([
      { title: 'done thing', done: true },
      { title: 'pending thing', done: false },
    ]);
  });
});

describe('detect', () => {
  const parser = new OpenSpecParser();

  it('matches high on a real tree, with its reasons attached', async () => {
    const result = await parser.detect(await tree());
    expect(result.matched).toBe(true);
    expect(result.confidence).toBe('high');
    expect(result.evidence.some((line) => line.includes('### Requirement:'))).toBe(true);
  });

  it('does not match a repo that never ran OpenSpec', async () => {
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'plain-'));
    dirs.push(empty);
    expect((await parser.detect(empty)).matched).toBe(false);
  });

  it('drops to medium when the directory exists but holds no requirements', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shell-'));
    dirs.push(root);
    await fs.mkdir(path.join(root, 'openspec', 'specs'), { recursive: true });
    const result = await parser.detect(root);
    // The directory says someone once ran OpenSpec. It does not say the contents
    // still parse as OpenSpec, and confidence is what separates the two.
    expect(result.matched).toBe(true);
    expect(result.confidence).toBe('medium');
  });
});

describe('parse', () => {
  const parser = new OpenSpecParser();

  it('turns each requirement into its own node', async () => {
    const { items } = await parser.parse(await tree());
    const specs = items.filter((item) => item.kind === 'spec');
    expect(specs.map((s) => s.title)).toEqual([
      'auth: User Authentication',
      'auth: Session Expiration',
    ]);
  });

  it('keeps the requirement title as a preserved identifier', async () => {
    const { items } = await parser.parse(await tree());
    // Teams cite these in commits and PRs; renumbering or renaming them breaks
    // those references as a human misreading a PR, not as an error.
    expect(items[0]?.preservedIdentifiers).toEqual(['User Authentication']);
  });

  it('marks a delta requirement with its verb and links it to the change', async () => {
    const { items } = await parser.parse(await tree());
    const removed = items.find((item) => item.title.includes('Remember Me'));
    expect(removed?.frontmatterHints['delta']).toBe('REMOVED');
    expect(removed?.relations[0]).toEqual({
      type: 'delta-of',
      targetExternalRef: 'openspec:openspec/changes/add-2fa:add-2fa',
    });
  });

  it('parents checklist tasks to their change', async () => {
    const { items } = await parser.parse(await tree());
    const tasks = items.filter((item) => item.kind === 'task');
    expect(tasks.map((t) => t.title)).toEqual(['Add TOTP library', 'Wire enrollment UI']);
    expect(tasks[0]?.relations[0]?.targetExternalRef).toBe(
      'openspec:openspec/changes/add-2fa:add-2fa',
    );
  });

  it('carries a checked task as a hint, not as a lifecycle claim', async () => {
    const { items } = await parser.parse(await tree());
    const done = items.find((item) => item.title === 'Add TOTP library');
    // The writer owns lifecycle. A parser asserting an item is finished would be
    // importing somebody's claim as a fact.
    expect(done?.frontmatterHints['source_checked']).toBe(true);
    expect(done?.frontmatterHints['lifecycle_state']).toBeUndefined();
  });

  it('imports archived changes, which are the only reconstructable history', async () => {
    const { items } = await parser.parse(await tree({ archived: true }));
    const change = items.find((item) => item.title === '2026-01-01-add-2fa');
    expect(change).toBeDefined();
    expect(change?.frontmatterHints['archived']).toBe(true);
  });

  it('warns and keeps going on a spec with no requirement headers', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'odd-'));
    dirs.push(root);
    await fs.mkdir(path.join(root, 'openspec', 'specs', 'notes'), { recursive: true });
    await fs.writeFile(
      path.join(root, 'openspec', 'specs', 'notes', 'spec.md'),
      'Just prose, no headers.\n',
      'utf8',
    );

    const result = await parser.parse(root);
    // Skip-and-warn, never abort: one odd file in four hundred cannot stop a
    // migration, and the person running it cannot know which file did it.
    expect(result.warnings).toHaveLength(1);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.body).toContain('Just prose');
  });

  it('produces nodes the writer can order and re-run idempotently', async () => {
    const root = await tree();
    const { items } = await parser.parse(root);

    const first = planImport(items, [], sha);
    expect(first.created).toBe(items.length);
    // Every relation resolves — a parser that emitted refs the writer cannot
    // match would import a flat pile with the hierarchy silently gone.
    expect(first.danglingRelations).toEqual([]);

    const existing = first.order.map((entry) => ({
      key: entry.key,
      contentHash: sha(`${entry.node.title}\n\n${entry.node.body}`),
    }));
    const second = planImport(items, existing, sha);
    // The whole promise of the framework: a re-run after fixing one source file
    // touches that file, not all of them.
    expect(second.created).toBe(0);
    expect(second.unchanged).toBe(items.length);
  });
});
