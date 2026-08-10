import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SpecKitParser, splitSections, splitTaskLines } from './speckit.js';
import { planImport } from './writer.js';

/**
 * P2-IMP-05 — the Spec Kit parser.
 *
 * The identifiers are the job. `FR-003` and `SC-001` are cited in commits and
 * PRs, so anything that renumbers or drops them breaks references in a way that
 * surfaces as a human misreading a PR rather than as an error.
 */

const dirs: string[] = [];
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const SPEC = `# Feature: Export

## User Story P1: Analyst exports rows

An analyst needs CSV output.

## Requirements

### FR-001 Export to CSV
The system MUST write UTF-8 CSV.

### FR-002 Quarantine bad rows
Rows that fail validation [NEEDS CLARIFICATION: what counts as failure?] are quarantined.

## Success Criteria

### SC-001 Throughput
Exports 10k rows in under 5 seconds.
`;

const TASKS = `# Tasks

- [x] T001 [P] [US1] Write the CSV encoder
- [ ] T002 [US1] Wire the quarantine path
`;

async function tree(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'speckit-'));
  dirs.push(root);
  const feature = path.join(root, 'specs', '001-export');
  await fs.mkdir(feature, { recursive: true });
  await fs.writeFile(path.join(feature, 'spec.md'), SPEC, 'utf8');
  await fs.writeFile(path.join(feature, 'plan.md'), '# Plan\n\nUse a stream.\n', 'utf8');
  await fs.writeFile(path.join(feature, 'tasks.md'), TASKS, 'utf8');
  await fs.mkdir(path.join(root, '.specify', 'memory'), { recursive: true });
  await fs.writeFile(
    path.join(root, '.specify', 'memory', 'constitution.md'),
    '# Constitution\n\nv1.2.0\n',
    'utf8',
  );
  return root;
}

describe('splitSections', () => {
  it('lifts the identifiers out of each section', () => {
    const sections = splitSections(SPEC);
    const fr1 = sections.find((s) => s.heading.includes('FR-001'));
    expect(fr1?.identifiers).toEqual(['FR-001']);
  });

  it('records an unanswered question rather than dropping the marker', () => {
    const fr2 = splitSections(SPEC).find((s) => s.heading.includes('FR-002'));
    // Dropping `[NEEDS CLARIFICATION]` would turn an open question into settled
    // prose — the one transformation nobody asked for.
    expect(fr2?.needsClarification).toBe(true);
  });

  it('reads a user story priority tier', () => {
    const story = splitSections(SPEC).find((s) => s.heading.includes('User Story'));
    expect(story?.priority).toBe('P1');
  });
});

describe('splitTaskLines', () => {
  it('separates the machine markers from the title', () => {
    const tasks = splitTaskLines(TASKS);
    // Leaving `[P]` in a card title turns a machine marker into prose.
    expect(tasks[0]).toEqual({
      title: 'T001 Write the CSV encoder',
      done: true,
      parallel: true,
      story: 'US1',
    });
  });

  it('keeps a non-parallel task marked as such', () => {
    expect(splitTaskLines(TASKS)[1]?.parallel).toBe(false);
  });
});

describe('detect', () => {
  const parser = new SpecKitParser();

  it('matches high on a real tree', async () => {
    const result = await parser.detect(await tree());
    expect(result.matched).toBe(true);
    expect(result.confidence).toBe('high');
  });

  it('does not claim a bare specs/ folder with no Spec Kit identifiers', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plain-specs-'));
    dirs.push(root);
    await fs.mkdir(path.join(root, 'specs', 'thing'), { recursive: true });
    await fs.writeFile(path.join(root, 'specs', 'thing', 'spec.md'), '# Just notes\n', 'utf8');

    // Half the repositories in the world have a `specs/` directory. Claiming it
    // on the name alone would make `detect` confidently wrong.
    expect((await parser.detect(root)).confidence).toBe('low');
  });

  it('does not match a repo with neither directory', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'none-'));
    dirs.push(root);
    expect((await parser.detect(root)).matched).toBe(false);
  });
});

describe('parse', () => {
  const parser = new SpecKitParser();

  it('imports the constitution when the project has one', async () => {
    const { items } = await parser.parse(await tree());
    expect(items.find((item) => item.kind === 'constitution')?.body).toContain('v1.2.0');
  });

  it('preserves FR-/SC- identifiers verbatim', async () => {
    const { items } = await parser.parse(await tree());
    const ids = items.flatMap((item) => item.preservedIdentifiers);
    expect(ids).toContain('FR-001');
    expect(ids).toContain('FR-002');
    expect(ids).toContain('SC-001');
  });

  it('keys a requirement on its identifier, so a retitle is an update not a duplicate', async () => {
    const root = await tree();
    const before = await parser.parse(root);
    const key = before.items.find((i) => i.preservedIdentifiers.includes('FR-001'))?.externalRef
      .source_id_or_hash;

    // A team rewords the heading and keeps the identifier — the ordinary case.
    // It is the same requirement, and the import must say so.
    await fs.writeFile(
      path.join(root, 'specs', '001-export', 'spec.md'),
      SPEC.replace('### FR-001 Export to CSV', '### FR-001 Export rows to CSV, streaming'),
      'utf8',
    );

    const after = await parser.parse(root);
    const keyAfter = after.items.find((i) => i.preservedIdentifiers.includes('FR-001'))?.externalRef
      .source_id_or_hash;
    // Keyed on the heading, this would mint a new item and orphan the old one,
    // so a wording tidy-up would silently duplicate half the requirements.
    expect(keyAfter).toBe(key);
    expect(key).toBe('FR-001');
  });

  it('carries the clarification marker onto the imported requirement', async () => {
    const { items } = await parser.parse(await tree());
    const fr2 = items.find((item) => item.preservedIdentifiers.includes('FR-002'));
    expect(fr2?.frontmatterHints['needs_clarification']).toBe(true);
  });

  it('parents requirements and tasks to their feature', async () => {
    const { items } = await parser.parse(await tree());
    const plan = planImport(items, [], sha);
    // Every relation resolves; a parser emitting refs the writer cannot match
    // imports a flat pile with the hierarchy silently gone.
    expect(plan.danglingRelations).toEqual([]);
  });

  it('does not report an absent optional file as a defect', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sk-min-'));
    dirs.push(root);
    await fs.mkdir(path.join(root, 'specs', '001-thing'), { recursive: true });
    await fs.writeFile(
      path.join(root, 'specs', '001-thing', 'spec.md'),
      '### FR-001 A thing\nMUST work.\n',
      'utf8',
    );

    const result = await parser.parse(root);
    // `plan.md` and `tasks.md` are optional. Reporting their absence as
    // "unreadable: ENOENT" makes a healthy import look broken, and trains the
    // reader to skim past the warning list that matters.
    expect(result.warnings).toEqual([]);
    expect(result.items.length).toBeGreaterThan(0);
  });

  it('warns rather than silently succeeding when there is nothing to import', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'empty-sk-'));
    dirs.push(root);
    await fs.mkdir(path.join(root, '.specify'), { recursive: true });
    const result = await parser.parse(root);
    expect(result.items).toEqual([]);
    expect(result.warnings[0]?.message).toContain('nothing was imported');
  });

  it('is idempotent through the writer', async () => {
    const { items } = await parser.parse(await tree());
    const first = planImport(items, [], sha);
    const existing = first.order.map((entry) => ({
      key: entry.key,
      contentHash: sha(`${entry.node.title}\n\n${entry.node.body}`),
    }));
    expect(planImport(items, existing, sha).created).toBe(0);
  });
});
