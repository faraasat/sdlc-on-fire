import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CANONICAL_SKILLS, renderPromptTemplate } from '@sdlc-on-fire/agent-manager';
import type { CanonicalSkill } from '@sdlc-on-fire/core';
import { init } from './commands.js';
import { compileSkills } from './skills.js';
import {
  BadSkillNameError,
  loadPromptOverride,
  overriddenSkill,
  promptOverridePath,
} from './prompts.js';

/**
 * Local prompt overlays, end to end (P6-SURFACE-08, FEAT-AGT-009).
 *
 * The claim under test is the one that matters for upgrades: a workspace can
 * change its prompts **without editing a canonical skill**, and the change
 * reaches the compiled surface every agent actually reads.
 */

const RM_RETRY = { maxRetries: 5, retryDelay: 100 } as const;
let root: string;

const someSkill = (): CanonicalSkill => {
  const skill = CANONICAL_SKILLS['implement'];
  if (skill === undefined) throw new Error('no implement skill to overlay');
  return skill;
};

async function writeOverride(skill: string, contents: string): Promise<void> {
  const file = promptOverridePath(root, skill);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, contents, 'utf8');
}

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'prompts-')));
  await init(root, { database: 'skip' });
}, 180_000);

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true, ...RM_RETRY });
});

describe('loading an overlay', () => {
  it('is absent when the workspace has none', async () => {
    expect(await loadPromptOverride(root, 'implement')).toBeNull();
  }, 180_000);

  it('takes the body as the append', async () => {
    await writeOverride('implement', 'We use tabs, and the linter is not negotiable.\n');
    const loaded = await loadPromptOverride(root, 'implement');
    expect(loaded?.override.prompt_append).toBe('We use tabs, and the linter is not negotiable.');
  }, 180_000);

  it('takes prompt_replace from the frontmatter', async () => {
    await writeOverride(
      'implement',
      ['---', 'prompt_replace:', '  role: You are our staff engineer.', '---', ''].join('\n'),
    );
    const loaded = await loadPromptOverride(root, 'implement');
    expect(loaded?.override.prompt_replace).toEqual({ role: 'You are our staff engineer.' });
    // Body was empty, so there is nothing to append — not an empty section.
    expect(loaded?.override.prompt_append).toBeUndefined();
  }, 180_000);

  it('refuses a skill name that would escape the prompts directory', () => {
    expect(() => promptOverridePath(root, '../../etc/passwd')).toThrow(BadSkillNameError);
  });
});

describe('applying an overlay', () => {
  it('puts the local text into the rendered prompt, last', async () => {
    await writeOverride('implement', 'Ship behind a flag.');
    const report = await overriddenSkill(root, someSkill());
    const rendered = renderPromptTemplate(report.skill);

    expect(rendered.text).toContain('Ship behind a flag.');
    expect(rendered.sections[rendered.sections.length - 1]?.kind).toBe('local-append');
  }, 180_000);

  it('does not touch the canonical skill object', async () => {
    await writeOverride('implement', 'local');
    await overriddenSkill(root, someSkill());
    expect(someSkill().prompt_append).toBeUndefined();
  }, 180_000);

  it('refuses to replace the output contract, and keeps the canonical one', async () => {
    await writeOverride(
      'implement',
      ['---', 'prompt_replace:', '  output-contract: just say ok', '---', ''].join('\n'),
    );
    const report = await overriddenSkill(root, someSkill());
    expect(report.refusals).toHaveLength(1);
    expect(renderPromptTemplate(report.skill).text).toContain('tool');
  }, 180_000);
});

describe('compiling with an overlay', () => {
  it('reaches the compiled surface an agent actually reads', async () => {
    await writeOverride('implement', 'Every PR names its rollback.');
    const result = await compileSkills(root);

    const written = await Promise.all(
      result.files.map((file) => fs.readFile(path.join(root, file.path), 'utf8')),
    );
    expect(written.some((body) => body.includes('Every PR names its rollback.'))).toBe(true);
    expect(result.overrides).toContainEqual({
      skill: 'implement',
      applied: ['appended local text'],
    });
  }, 180_000);

  it('warns on a refused replacement rather than failing the whole compile', async () => {
    await writeOverride(
      'implement',
      ['---', 'prompt_replace:', '  stop-condition: never stop', '---', ''].join('\n'),
    );
    // One stale overlay must not stop every other skill from building.
    const result = await compileSkills(root);
    expect(result.files.length).toBeGreaterThan(0);
    expect(result.warnings.some((w) => w.includes('cannot replace `stop-condition`'))).toBe(true);
  }, 180_000);

  it('compiles unchanged when no workspace overlay exists', async () => {
    const result = await compileSkills(root);
    expect(result.overrides).toEqual([]);
  }, 180_000);
});
