import fs from 'node:fs/promises';
import path from 'node:path';
import {
  formatOverride,
  overrideSkill,
  PromptOverrideSchema,
  resolveWorkspaceLayout,
  type CanonicalSkill,
  type OverrideResult,
  type PromptOverride,
} from '@sdlc-on-fire/core';
import { parseFrontmatter } from '@sdlc-on-fire/storage';

/**
 * Reading a local prompt overlay off disk (P6-SURFACE-08, FEAT-AGT-009).
 *
 * One file per skill at `docs/prompts/<skill>.md`: frontmatter carries
 * `prompt_replace`, and **the body is the append**. That shape is deliberate —
 * the common customisation is a paragraph of local context, and asking someone
 * to escape a paragraph into a YAML scalar is how a feature goes unused.
 */

export const PROMPT_OVERRIDE_EXT = '.md';

export class BadSkillNameError extends Error {
  override readonly name = 'BadSkillNameError';
  constructor(skill: string) {
    super(`not a skill name: ${JSON.stringify(skill)}`);
  }
}

export function promptOverridePath(root: string, skill: string): string {
  // The skill name reaches a filesystem path. Refuse the shape rather than
  // sanitise it: a `..` redirects the read somewhere nobody asked for.
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill)) throw new BadSkillNameError(skill);
  return path.join(resolveWorkspaceLayout(root).promptsDir, `${skill}${PROMPT_OVERRIDE_EXT}`);
}

export interface LoadedOverride {
  readonly override: PromptOverride;
  readonly path: string;
}

/** The overlay for one skill, or null when the workspace has none. */
export async function loadPromptOverride(
  root: string,
  skill: string,
): Promise<LoadedOverride | null> {
  const file = promptOverridePath(root, skill);
  const raw = await fs.readFile(file, 'utf8').catch(() => null);
  if (raw === null) return null;

  const parsed = parseFrontmatter(raw);
  const body = parsed.body.trim();
  const replace = parsed.data['prompt_replace'];
  return {
    path: file,
    override: PromptOverrideSchema.parse({
      skill,
      ...(body === '' ? {} : { prompt_append: body }),
      ...(replace === undefined ? {} : { prompt_replace: replace }),
    }),
  };
}

export interface OverrideReport extends OverrideResult {
  readonly name: string;
  readonly overridePath: string | null;
}

/** One skill, with this workspace's overlay applied. */
export async function overriddenSkill(
  root: string,
  skill: CanonicalSkill,
): Promise<OverrideReport> {
  const loaded = await loadPromptOverride(root, skill.name).catch(() => null);
  const result = overrideSkill(skill, loaded?.override ?? null);
  return { ...result, name: skill.name, overridePath: loaded?.path ?? null };
}

/**
 * Every skill, overlaid.
 *
 * Applied here, once, before anything compiles — so no adapter has to know
 * overlays exist and none of them can forget to apply one.
 */
export async function overriddenSkills(
  root: string,
  skills: readonly CanonicalSkill[],
): Promise<readonly OverrideReport[]> {
  return Promise.all(skills.map((skill) => overriddenSkill(root, skill)));
}

export function formatOverrideReport(report: OverrideReport): string {
  if (report.overridePath === null) {
    return `${report.name}: no local override (docs/prompts/${report.name}.md)`;
  }
  return [`${report.name}: ${report.overridePath}`, formatOverride(report)].join('\n');
}
