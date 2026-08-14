import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BmadV4Parser,
  BmadV6Parser,
  parseSprintStatus,
  parseStoryCapsule,
  resolveV4Locations,
} from './bmad.js';
import { planImport } from './writer.js';

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
 * P2-IMP-06 — the BMAD parsers.
 *
 * BMAD is the one source tool that needs **two** parsers: the v4→v6 rewrite
 * moved the output folder and renamed modules, and BMAD stamps no readable
 * version into its artifacts — so the dialects are told apart by layout, and
 * the test that matters most is that neither claims the other's tree.
 */

const dirs: string[] = [];
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true, ...RM_RETRY })),
  );
});

const STORY = `# Export rows to CSV

## Dev Notes

The encoder streams. [Source: docs/architecture.md#Data-Model]
Validation rules are listed in [Source: docs/prd.md#Validation].

baseline_commit: a1b2c3d4e5f

## Edit contract

Only modify these files:
- src/encoder.ts
- src/encoder.test.ts
`;

async function v6Tree(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bmad6-'));
  dirs.push(root);
  const out = path.join(root, '_bmad-output');
  await fs.mkdir(path.join(out, 'planning-artifacts', 'epics', 'epic-1-export'), {
    recursive: true,
  });
  await fs.mkdir(path.join(out, 'implementation-artifacts'), { recursive: true });
  await fs.mkdir(path.join(root, '_bmad'), { recursive: true });

  await fs.writeFile(path.join(out, 'project-context.md'), '# Context\n\nShip fast.\n', 'utf8');
  await fs.writeFile(path.join(out, 'planning-artifacts', 'prd.md'), '# PRD\n', 'utf8');
  await fs.writeFile(
    path.join(out, 'planning-artifacts', 'architecture.md'),
    '# Architecture\n',
    'utf8',
  );
  await fs.writeFile(
    path.join(out, 'planning-artifacts', 'epics', 'epic-1-export', '1.1-export-rows.md'),
    STORY,
    'utf8',
  );
  await fs.writeFile(
    path.join(out, 'implementation-artifacts', 'sprint-status.yaml'),
    '1.1-export-rows: in-progress\n',
    'utf8',
  );
  return root;
}

async function v4Tree(over: { sharded?: boolean; movedPrd?: boolean } = {}): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bmad4-'));
  dirs.push(root);
  await fs.mkdir(path.join(root, '.bmad-core'), { recursive: true });
  await fs.mkdir(path.join(root, 'docs', 'stories'), { recursive: true });
  await fs.mkdir(path.join(root, 'docs', 'epics'), { recursive: true });

  const config = [
    over.movedPrd === true ? 'prd: planning/requirements.md' : 'prd: docs/prd.md',
    'architecture: docs/architecture.md',
    'devStoryLocation: docs/stories',
    'epicLocation: docs/epics',
    over.sharded === true ? 'prdSharded: true\nprdShardedLocation: docs/prd' : 'prdSharded: false',
  ].join('\n');
  await fs.writeFile(path.join(root, '.bmad-core', 'core-config.yml'), `${config}\n`, 'utf8');

  if (over.movedPrd === true) {
    await fs.mkdir(path.join(root, 'planning'), { recursive: true });
    await fs.writeFile(path.join(root, 'planning', 'requirements.md'), '# Moved PRD\n', 'utf8');
  } else {
    await fs.writeFile(path.join(root, 'docs', 'prd.md'), '# PRD\n', 'utf8');
  }
  if (over.sharded === true) {
    await fs.mkdir(path.join(root, 'docs', 'prd'), { recursive: true });
    await fs.writeFile(path.join(root, 'docs', 'prd', 'epic-1.md'), '# Shard one\n', 'utf8');
    await fs.writeFile(path.join(root, 'docs', 'prd', 'epic-2.md'), '# Shard two\n', 'utf8');
  }
  await fs.writeFile(path.join(root, 'docs', 'architecture.md'), '# Architecture\n', 'utf8');
  await fs.writeFile(path.join(root, 'docs', 'epics', 'epic-1.md'), '# Epic one\n', 'utf8');
  await fs.writeFile(path.join(root, 'docs', 'stories', 'epic-1.1.export.md'), STORY, 'utf8');
  return root;
}

describe('parseStoryCapsule', () => {
  it('keeps the inline [Source:] provenance trail', () => {
    const capsule = parseStoryCapsule(STORY, 'fallback');
    // Dropping this would turn grounded prose into an assertion, with no way
    // for a reader to tell which it was.
    expect(capsule.citations).toEqual([
      'docs/architecture.md#Data-Model',
      'docs/prd.md#Validation',
    ]);
  });

  it('reads the edit contract as a file list', () => {
    expect(parseStoryCapsule(STORY, 'x').editContract).toEqual([
      'src/encoder.ts',
      'src/encoder.test.ts',
    ]);
  });

  it('records the baseline commit', () => {
    expect(parseStoryCapsule(STORY, 'x').baselineCommit).toBe('a1b2c3d4e5f');
  });

  it('falls back to the filename when the story has no heading', () => {
    expect(parseStoryCapsule('no heading here\n', 'story-7').title).toBe('story-7');
  });
});

describe('parseSprintStatus', () => {
  it('reads a flat id: status map', () => {
    expect(parseSprintStatus('1.1-export: done\n1.2-import: review\n').get('1.1-export')).toBe(
      'done',
    );
  });

  it('reads a list of entries', () => {
    const map = parseSprintStatus('stories:\n  - id: "1.1"\n    status: in-progress\n');
    expect(map.get('1.1')).toBe('in-progress');
  });

  it('costs status hints, not the import, when the file is malformed', () => {
    expect(parseSprintStatus('{{{not yaml').size).toBe(0);
  });
});

describe('resolveV4Locations', () => {
  it('uses the documented defaults when there is no config', () => {
    expect(resolveV4Locations(null).prd).toBe('docs/prd.md');
    expect(resolveV4Locations(null).stories).toBe('docs/stories');
  });

  it('honours a moved document, which is what the config exists for', () => {
    // Hardcoding `docs/prd.md` would import nothing from a project that used
    // the feature BMAD's own agents read this file to support.
    expect(resolveV4Locations('prd: planning/requirements.md\n').prd).toBe(
      'planning/requirements.md',
    );
  });

  it('falls back to defaults rather than failing on a malformed config', () => {
    expect(resolveV4Locations('{{{ not yaml').prd).toBe('docs/prd.md');
  });
});

describe('v6', () => {
  const parser = new BmadV6Parser();

  it('matches high on a real tree', async () => {
    const result = await parser.detect(await v6Tree());
    expect(result.confidence).toBe('high');
  });

  it('imports project-context.md as the constitution', async () => {
    const { items } = await parser.parse(await v6Tree());
    expect(items.find((i) => i.kind === 'constitution')?.title).toBe('Project context');
  });

  it('parents a story to its epic folder', async () => {
    const { items } = await parser.parse(await v6Tree());
    expect(planImport(items, [], sha).danglingRelations).toEqual([]);
    expect(items.some((i) => i.kind === 'epic' && i.title === 'epic-1-export')).toBe(true);
  });

  it('carries sprint status as the source’s claim, not as a lifecycle state', async () => {
    const { items } = await parser.parse(await v6Tree());
    const story = items.find((i) => i.kind === 'story');
    // `status: done` in somebody's sprint file is not evidence that anything
    // passed, and this product exists to keep that distinction.
    expect(story?.frontmatterHints['source_status']).toBe('in-progress');
    expect(story?.frontmatterHints['lifecycle_state']).toBeUndefined();
  });

  it('flags a baseline commit as unverified rather than trusting it', async () => {
    const { items } = await parser.parse(await v6Tree());
    const story = items.find((i) => i.kind === 'story');
    // A story pinned to a commit that no longer exists was planned against a
    // tree that is gone. The parser cannot check that — it has no git — so it
    // marks it for the import stage instead of staying silent.
    expect(story?.frontmatterHints['baseline_commit']).toBe('a1b2c3d4e5f');
    expect(story?.frontmatterHints['baseline_commit_unverified']).toBe(true);
  });

  it('carries the [Source:] trail onto the imported story, not just into the capsule', async () => {
    const { items } = await parser.parse(await v6Tree());
    const story = items.find((i) => i.kind === 'story');
    // Parsed-but-dropped is the failure that matters: the capsule can read them
    // perfectly and the import still arrive without them.
    expect(story?.frontmatterHints['source_citations']).toEqual([
      'docs/architecture.md#Data-Model',
      'docs/prd.md#Validation',
    ]);
  });

  it('carries the edit contract onto the imported story as file ownership', async () => {
    const { items } = await parser.parse(await v6Tree());
    const story = items.find((i) => i.kind === 'story');
    // "Only modify these files" is a constraint the source author wrote down;
    // losing it on import turns a scoped story into an unscoped one.
    expect(story?.frontmatterHints['file_ownership']).toEqual([
      'src/encoder.ts',
      'src/encoder.test.ts',
    ]);
  });

  it('warns rather than silently succeeding on an empty tree', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bmad6-empty-'));
    dirs.push(root);
    await fs.mkdir(path.join(root, '_bmad-output'), { recursive: true });
    const result = await parser.parse(root);
    expect(result.items).toEqual([]);
    expect(result.warnings[0]?.message).toContain('nothing was imported');
  });
});

describe('v4', () => {
  const parser = new BmadV4Parser();

  it('matches high on a real tree with a config', async () => {
    expect((await parser.detect(await v4Tree())).confidence).toBe('high');
  });

  it('reads a moved PRD out of core-config.yml', async () => {
    const { items } = await parser.parse(await v4Tree({ movedPrd: true }));
    expect(items.find((i) => i.title === 'prd')?.body).toContain('Moved PRD');
  });

  it('imports every shard of a sharded PRD', async () => {
    const { items } = await parser.parse(await v4Tree({ sharded: true }));
    // Reading only `prd.md` on a sharded project imports a stub and silently
    // drops the actual requirements.
    const shards = items.filter((i) => i.frontmatterHints['sharded_from'] === 'prd');
    expect(shards.map((s) => s.title)).toEqual(['prd: epic-1', 'prd: epic-2']);
  });

  it('parents a story to its epic by the leading name segment', async () => {
    const { items } = await parser.parse(await v4Tree());
    expect(planImport(items, [], sha).danglingRelations).toEqual([]);
    const story = items.find((i) => i.kind === 'story');
    expect(story?.relations[0]?.targetExternalRef).toContain('epic-1');
  });
});

describe('telling the two dialects apart', () => {
  it('does not let v4 claim a v6 tree', async () => {
    const v6 = await v6Tree();
    // BMAD stamps no readable version into its artifacts, so the only way to
    // separate them is layout — and a v6 project must be excluded explicitly.
    expect((await new BmadV4Parser().detect(v6)).matched).toBe(false);
    expect((await new BmadV6Parser().detect(v6)).matched).toBe(true);
  });

  it('does not let v6 claim a v4 tree', async () => {
    const v4 = await v4Tree();
    expect((await new BmadV6Parser().detect(v4)).matched).toBe(false);
    expect((await new BmadV4Parser().detect(v4)).matched).toBe(true);
  });

  it('does not let v4 claim a repo mid-upgrade that has BOTH markers', async () => {
    // The case the exclusion actually exists for. A project part-way from v4 to
    // v6 still has `.bmad-core/` lying around, so "no .bmad-core" is not what
    // separates them — the presence of `_bmad-output/` is. My first test used a
    // pure v6 tree, which passed with the check removed.
    const root = await v6Tree();
    await fs.mkdir(path.join(root, '.bmad-core'), { recursive: true });
    await fs.writeFile(
      path.join(root, '.bmad-core', 'core-config.yml'),
      'prd: docs/prd.md\n',
      'utf8',
    );

    expect((await new BmadV4Parser().detect(root)).matched).toBe(false);
    expect((await new BmadV6Parser().detect(root)).matched).toBe(true);
  });

  it('says which it excluded, and why', async () => {
    const result = await new BmadV4Parser().detect(await v6Tree());
    expect(result.evidence.join(' ')).toContain('this is v6, not v4');
  });
});
