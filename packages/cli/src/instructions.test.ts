import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { init, instructions, findWorkItem } from './commands.js';
import { resolveWorkspaceLayout } from '@sdlc-on-fire/core';

/**
 * `sdlc instructions` (P0-CLI-02).
 *
 * The command's whole value is that the answer is *computed*, not suggested —
 * so these tests pin the ladder arithmetic and the cases where the honest
 * answer is "no skill", which a caller must not mistake for "dispatch
 * anything".
 */

let root: string;

async function writeCard(id: string, frontmatter: Record<string, string>): Promise<void> {
  const layout = resolveWorkspaceLayout(root);
  const dir = path.join(layout.kanbanDir, '_inbox');
  await fs.mkdir(dir, { recursive: true });
  const yaml = Object.entries(frontmatter)
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n');
  await fs.writeFile(
    path.join(dir, `${id}.md`),
    `---\nid: ${id}\n${yaml}\n---\n\n## Description\n\nExport rows as CSV.\n`,
    'utf8',
  );
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'instructions-'));
  await init(root);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('finding the card', () => {
  it('locates a work item nested anywhere under kanban/', async () => {
    const layout = resolveWorkspaceLayout(root);
    const deep = path.join(layout.kanbanDir, 'epics', 'EPIC-001-x', 'features', 'FEAT-009-y');
    await fs.mkdir(deep, { recursive: true });
    await fs.writeFile(path.join(deep, 'feature.md'), `---\nid: FEAT-009\n---\n\nbody\n`, 'utf8');

    const found = await findWorkItem(layout.kanbanDir, 'FEAT-009');
    expect(found?.filePath).toContain('FEAT-009-y');
  });

  it('fails loudly for an unknown id rather than returning an empty plan', async () => {
    await expect(instructions(root, 'FEAT-404')).rejects.toThrow(/no work item with id/);
  });
});

describe('computing the next step', () => {
  it('walks the standard feature ladder from plan to implement', async () => {
    await writeCard('FEAT-001', {
      title: 'CSV export',
      kind: 'feature',
      preset: 'standard',
      work_type: 'feature',
      lifecycle_state: 'plan',
    });

    const result = await instructions(root, 'FEAT-001');
    expect(result.nextStage).toBe('implement');
    expect(result.terminal).toBe(false);
    expect(result.skill?.name).toBe('implement');
  });

  it('reports a stage the v0.1 cut has no skill for, rather than guessing', async () => {
    // standard/feature is discovery → spec → decompose → plan → …, and
    // decompose is explicitly deferred past v0.1 (mvp-slice). The honest answer
    // is "no skill", not the nearest skill that happens to exist.
    await writeCard('FEAT-007', {
      title: 'CSV export',
      kind: 'feature',
      preset: 'standard',
      work_type: 'feature',
      lifecycle_state: 'spec',
    });

    const result = await instructions(root, 'FEAT-007');
    expect(result.nextStage).toBe('decompose');
    expect(result.skill).toBeNull();
    expect(result.reason).toMatch(/No skill drives the "decompose" stage/);
  });

  it('gives a task its shorter ladder (ADR-0070)', async () => {
    await writeCard('TASK-001', {
      title: 'Rename a column',
      kind: 'task',
      preset: 'standard',
      work_type: 'task',
      lifecycle_state: 'implement',
    });

    // standard/task is implement → test → review → done: verify comes next,
    // and verify is the daemon's job.
    const result = await instructions(root, 'TASK-001');
    expect(result.nextStage).toBe('test');
    expect(result.skill).toBeNull();
    expect(result.reason).toMatch(/daemon runs verify/);
  });

  it('reports terminal rather than inventing a next stage', async () => {
    await writeCard('TASK-002', {
      title: 'Done already',
      kind: 'task',
      preset: 'lite',
      work_type: 'task',
      lifecycle_state: 'done',
    });

    const result = await instructions(root, 'TASK-002');
    expect(result.terminal).toBe(true);
    expect(result.nextStage).toBeNull();
    expect(result.skill).toBeNull();
    expect(result.reason).toMatch(/end of its ladder/);
  });

  it('says so when the recorded stage is not on the item ladder', async () => {
    // A preset change can strand an item on a stage its new ladder lacks.
    await writeCard('FEAT-002', {
      title: 'Stranded',
      kind: 'feature',
      preset: 'lite',
      work_type: 'feature',
      lifecycle_state: 'security_review',
    });

    const result = await instructions(root, 'FEAT-002');
    expect(result.nextStage).toBeNull();
    expect(result.reason).toMatch(/not on the lite\/feature ladder/);
  });

  it('resolves the review stage now that the review skill is registered', async () => {
    await writeCard('FEAT-003', {
      title: 'Ready for review',
      kind: 'feature',
      preset: 'standard',
      work_type: 'feature',
      lifecycle_state: 'test',
    });

    const result = await instructions(root, 'FEAT-003');
    expect(result.nextStage).toBe('review');
    expect(result.skill?.name).toBe('review');
  });
});

describe('the returned template and context', () => {
  it('fills the skill slots so the prompt is ready to dispatch', async () => {
    await writeCard('FEAT-004', {
      title: 'CSV export',
      kind: 'feature',
      preset: 'standard',
      work_type: 'feature',
      lifecycle_state: 'plan',
    });

    const result = await instructions(root, 'FEAT-004');
    expect(result.skill?.task).toContain('FEAT-004');
    expect(result.skill?.task).toContain('CSV export');
    expect(result.skill?.task).not.toContain('{{');
  });

  it('carries the card body, not just its title', async () => {
    await writeCard('FEAT-005', {
      title: 'CSV export',
      kind: 'feature',
      preset: 'standard',
      work_type: 'feature',
      lifecycle_state: 'plan',
    });

    const result = await instructions(root, 'FEAT-005');
    expect(result.context?.cardCore).toContain('Export rows as CSV.');
    expect(result.context?.estimatedTokens).toBeGreaterThan(0);
  });

  it('names the output contract the agent must answer with', async () => {
    await writeCard('FEAT-006', {
      title: 'CSV export',
      kind: 'feature',
      preset: 'standard',
      work_type: 'feature',
      lifecycle_state: 'plan',
    });

    const result = await instructions(root, 'FEAT-006');
    expect(result.skill?.outputContract.toolName).toBe('implement_output');
  });
});

describe('init honours the config doc toggles (P0-CLI-03)', () => {
  it('emits the full doc set when nothing is configured', async () => {
    const fresh = await fs.mkdtemp(path.join(os.tmpdir(), 'init-default-'));
    await init(fresh);
    const docs = await fs.readdir(path.join(fresh, 'docs'));
    expect(docs).toContain('TESTING.md');
    expect(docs).toContain('SCALING.md');
    await fs.rm(fresh, { recursive: true, force: true });
  });

  it('emits only the configured subset on a re-run', async () => {
    // `docsToGenerate` shipped with P0-OBJ-02 and was tested there, but nothing
    // called it — so narrowing `docs.generate` silently did nothing.
    const layout = resolveWorkspaceLayout(root);
    await fs.writeFile(
      layout.configPath,
      'database:\n  mode: pglite\npreset: standard\ndocs:\n  generate:\n    - README.md\n    - TESTING.md\n',
      'utf8',
    );

    const scaled = await fs.mkdtemp(path.join(os.tmpdir(), 'init-scoped-'));
    await fs.mkdir(path.join(scaled, '.sdlcof'), { recursive: true });
    await fs.copyFile(layout.configPath, path.join(scaled, '.sdlcof', 'config.yaml'));

    await init(scaled);
    // Directories (architectural-design-decisions/, assets/) are structural and
    // unaffected by the toggle; only generated topic files should narrow.
    const docs = (await fs.readdir(path.join(scaled, 'docs')))
      .filter((entry) => entry.endsWith('.md'))
      .sort();
    expect(docs).toEqual(['README.md', 'TESTING.md']);
    await fs.rm(scaled, { recursive: true, force: true });
  });
});
