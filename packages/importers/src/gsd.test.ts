import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  flattenGsd2,
  Gsd2Parser,
  GsdPlanningParser,
  parseRoadmap,
  parseTaskBlocks,
} from './gsd.js';
import { planImport } from './writer.js';

/**
 * P2-IMP-04 — the GSD parsers.
 *
 * GSD is the most fragmented of the four source tools, so the tests are mostly
 * about *tolerating shape*: two near-identical lineages under `.planning/`, a
 * third that nests one level deeper under `.gsd/`, and release wrinkles
 * (milestone archives, nested plan folders, project-code prefixes) that a
 * parser must absorb without being told which release it is looking at.
 */

const dirs: string[] = [];
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const PLAN = `# Plan 01-01

<task type="auto">
  <name>Add the CSV encoder</name>
  <files>src/encoder.ts</files>
  <action>Stream rows through a transform.</action>
  <verify>pnpm test encoder</verify>
  <done>Encoder emits UTF-8 with a BOM-free header.</done>
</task>

<task type="manual">
  <name>Review the output with the analyst</name>
  <action>Walk through a sample export.</action>
</task>
`;

async function planningTree(
  over: { nested?: boolean; milestoneArchive?: boolean; summary?: boolean } = {},
): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gsd-'));
  dirs.push(root);
  const base = path.join(root, '.planning');
  await fs.mkdir(base, { recursive: true });

  await fs.writeFile(path.join(base, 'PROJECT.md'), '# Project\n\nExport rows.\n', 'utf8');
  await fs.writeFile(
    path.join(base, 'REQUIREMENTS.md'),
    '# Requirements\n\nREQ-001 The system exports CSV.\n',
    'utf8',
  );
  await fs.writeFile(
    path.join(base, 'ROADMAP.md'),
    '# Roadmap\n\n- [x] 01-foundation\n- [ ] 02-polish\n',
    'utf8',
  );

  const phaseRoot =
    over.milestoneArchive === true
      ? path.join(base, 'milestones', 'v1.2-phases')
      : path.join(base, 'phases');
  const phaseDir = path.join(phaseRoot, '01-foundation');
  await fs.mkdir(phaseDir, { recursive: true });
  await fs.writeFile(path.join(phaseDir, 'CONTEXT.md'), 'Prefer streaming.\n', 'utf8');

  if (over.nested === true) {
    await fs.mkdir(path.join(phaseDir, 'plans'), { recursive: true });
    await fs.writeFile(path.join(phaseDir, 'plans', '1-PLAN-01-encoder.md'), PLAN, 'utf8');
    if (over.summary === true) {
      await fs.writeFile(path.join(phaseDir, 'plans', '1-SUMMARY-01-encoder.md'), 'ran\n', 'utf8');
    }
  } else {
    await fs.writeFile(path.join(phaseDir, '01-01-PLAN.md'), PLAN, 'utf8');
    if (over.summary === true) {
      await fs.writeFile(path.join(phaseDir, '01-01-SUMMARY.md'), 'ran\n', 'utf8');
    }
  }
  return root;
}

async function gsd2Tree(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gsd2-'));
  dirs.push(root);
  for (const [milestone, slices] of [
    ['M001', ['S01', 'S02']],
    ['M002', ['S01']],
  ] as const) {
    for (const slice of slices) {
      const sliceDir = path.join(root, '.gsd', 'milestones', milestone, 'slices', slice, 'tasks');
      await fs.mkdir(sliceDir, { recursive: true });
      await fs.writeFile(path.join(sliceDir, 'T01-PLAN.md'), PLAN, 'utf8');
      await fs.writeFile(
        path.join(sliceDir, '..', `${slice}-RESEARCH.md`),
        `Research for ${slice}.\n`,
        'utf8',
      );
    }
  }
  return root;
}

describe('parseTaskBlocks', () => {
  it('reads the verify command and done criteria — the richest thing GSD carries', () => {
    const tasks = parseTaskBlocks(PLAN);
    expect(tasks[0]?.verify).toBe('pnpm test encoder');
    expect(tasks[0]?.done).toContain('BOM-free');
    expect(tasks[0]?.files).toBe('src/encoder.ts');
    expect(tasks[0]?.type).toBe('auto');
  });

  it('keeps a task that omits the optional tags', () => {
    const manual = parseTaskBlocks(PLAN)[1];
    expect(manual?.name).toBe('Review the output with the analyst');
    expect(manual?.verify).toBeUndefined();
  });

  it('survives a plan whose XML is not well-formed as a document', () => {
    // These blocks live inside Markdown and routinely contain unescaped `&` in
    // shell commands. A strict parser would reject the whole plan over one.
    const messy = `<task><name>Ship it</name><verify>a && b</verify></task>\n<p>unclosed`;
    expect(parseTaskBlocks(messy)[0]?.verify).toBe('a && b');
  });

  it('skips a block with no name rather than importing a nameless task', () => {
    expect(parseTaskBlocks('<task><action>do</action></task>')).toEqual([]);
  });
});

describe('parseRoadmap', () => {
  it('reads phase status markers', () => {
    expect(parseRoadmap('- [x] 01-foundation\n- [ ] 02-polish\n')).toEqual([
      { title: '01-foundation', done: true },
      { title: '02-polish', done: false },
    ]);
  });
});

describe('the .planning lineages (classic + gsd-core)', () => {
  const parser = new GsdPlanningParser();

  it('matches high on a real tree', async () => {
    const result = await parser.detect(await planningTree());
    expect(result.matched).toBe(true);
    expect(result.confidence).toBe('high');
  });

  it('does not claim an empty .planning/ with confidence', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gsd-empty-'));
    dirs.push(root);
    await fs.mkdir(path.join(root, '.planning'), { recursive: true });
    // The directory alone proves someone once ran GSD, not that anything is
    // there to import.
    expect((await parser.detect(root)).confidence).toBe('low');
  });

  it('imports PROJECT.md as the constitution', async () => {
    const { items } = await parser.parse(await planningTree());
    expect(items.find((i) => i.kind === 'constitution')?.title).toBe('Project');
  });

  it('preserves REQ- identifiers', async () => {
    const { items } = await parser.parse(await planningTree());
    expect(items.flatMap((i) => i.preservedIdentifiers)).toContain('REQ-001');
  });

  it('carries the verify command onto the imported task', async () => {
    const { items } = await parser.parse(await planningTree());
    const task = items.find((i) => i.title === 'Add the CSV encoder');
    // The one thing GSD gives us that the other three formats cannot: a real
    // command, which is exactly what our gate needs.
    expect(task?.frontmatterHints['verify']).toBe('pnpm test encoder');
    expect(task?.frontmatterHints['done_criteria']).toContain('BOM-free');
  });

  it('treats a SUMMARY file as a hint, never as a lifecycle state', async () => {
    const { items } = await parser.parse(await planningTree({ summary: true }));
    const task = items.find((i) => i.title === 'Add the CSV encoder');
    // "Finished" is something evidence says, not something a filename says.
    expect(task?.frontmatterHints['source_executed']).toBe(true);
    expect(task?.frontmatterHints['lifecycle_state']).toBeUndefined();
  });

  it('finds the SUMMARY beside a nested plan too', async () => {
    const { items } = await parser.parse(await planningTree({ nested: true, summary: true }));
    const task = items.find((i) => i.title === 'Add the CSV encoder');
    // The nested layout renames differently (`1-PLAN-01-x.md` →
    // `1-SUMMARY-01-x.md`), so the basename rewrite has to hold for both.
    expect(task?.frontmatterHints['source_executed']).toBe(true);
  });

  it('does not mistake the .planning directory for a plan filename', async () => {
    // `.planning/` contains the word "plan" case-insensitively. Deriving the
    // SUMMARY path from the full path rewrote the *directory* name, pointing at
    // somewhere that does not exist — so nothing ever looked executed.
    const { items } = await parser.parse(await planningTree({ summary: false }));
    const task = items.find((i) => i.title === 'Add the CSV encoder');
    expect(task?.frontmatterHints['source_executed']).toBe(false);
  });

  it('carries the roadmap checkbox as a hint on the phase', async () => {
    const { items } = await parser.parse(await planningTree());
    const phase = items.find((i) => i.kind === 'story');
    expect(phase?.frontmatterHints['source_checked']).toBe(true);
  });

  it('finds plans nested under plans/ as well as flat', async () => {
    const nested = await parser.parse(await planningTree({ nested: true }));
    // A release wrinkle, not a dialect — tolerated rather than sniffed.
    expect(nested.items.some((i) => i.title === 'Add the CSV encoder')).toBe(true);
  });

  it('finds phases archived under milestones/', async () => {
    const archived = await parser.parse(await planningTree({ milestoneArchive: true }));
    expect(archived.items.some((i) => i.title === 'Add the CSV encoder')).toBe(true);
  });

  it('warns on a plan with no task blocks instead of dropping it', async () => {
    const root = await planningTree();
    await fs.writeFile(
      path.join(root, '.planning', 'phases', '01-foundation', '01-02-PLAN.md'),
      '# Just prose\n',
      'utf8',
    );
    const result = await parser.parse(root);
    expect(result.warnings.some((w) => w.message.includes('no <task> blocks'))).toBe(true);
    expect(result.items.some((i) => i.title.includes('01-02-PLAN.md'))).toBe(true);
  });

  it('produces a hierarchy the writer can resolve', async () => {
    const { items } = await parser.parse(await planningTree());
    expect(planImport(items, [], sha).danglingRelations).toEqual([]);
  });
});

describe('GSD-2, flattened through the documented mapping', () => {
  const parser = new Gsd2Parser();

  it('renumbers slices sequentially across milestones, not per milestone', async () => {
    const flat = await flattenGsd2(path.join(await gsd2Tree(), '.gsd'));
    // M002's first slice is phase 3 because M001 had two. Numbering per
    // milestone would produce two phase 1s and an import nobody can order.
    expect(flat.map((f) => f.phaseName)).toEqual(['01-m001-s01', '02-m001-s02', '03-m002-s01']);
  });

  it('matches high on a real .gsd tree', async () => {
    const result = await parser.detect(await gsd2Tree());
    expect(result.confidence).toBe('high');
    expect(result.evidence.join(' ')).toContain('3 slice(s)');
  });

  it('does not match a .planning-only repo', async () => {
    expect((await parser.detect(await planningTree())).matched).toBe(false);
  });

  it('records the v1 phase each slice maps onto', async () => {
    const { items } = await parser.parse(await gsd2Tree());
    const first = items.find((i) => i.kind === 'story');
    // So an imported tree is comparable to what `/gsd-import --from-gsd2`
    // would have produced, rather than to a numbering we invented.
    expect(first?.frontmatterHints['mapped_phase']).toBe('01-m001-s01');
  });

  it('extracts the same task detail as the v1 path', async () => {
    const { items } = await parser.parse(await gsd2Tree());
    const task = items.find((i) => i.title === 'Add the CSV encoder');
    expect(task?.frontmatterHints['verify']).toBe('pnpm test encoder');
  });

  it('produces a hierarchy the writer can resolve', async () => {
    const { items } = await parser.parse(await gsd2Tree());
    expect(planImport(items, [], sha).danglingRelations).toEqual([]);
  });

  it('is idempotent through the writer', async () => {
    const { items } = await parser.parse(await gsd2Tree());
    const first = planImport(items, [], sha);
    const existing = first.order.map((entry) => ({
      key: entry.key,
      contentHash: sha(`${entry.node.title}\n\n${entry.node.body}`),
    }));
    expect(planImport(items, existing, sha).created).toBe(0);
  });
});
