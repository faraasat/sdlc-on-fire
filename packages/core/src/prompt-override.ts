import { z } from 'zod';
import type { CanonicalSkill } from './skill.js';

/**
 * Local prompt customisation that does not fork the skill (P6-SURFACE-08,
 * FEAT-AGT-009).
 *
 * The problem is an upgrade problem, not a prompt problem. A team that wants
 * one extra paragraph in its `implement` prompt has had exactly one option:
 * copy the canonical skill into their repo and edit it — and from that moment
 * every upstream improvement to that skill is a manual merge they will not do.
 * The customisation is cheap; losing update compatibility is what it costs.
 *
 * So the overlay produces an **overridden skill**, and everything downstream —
 * every adapter, every target surface — compiles it without knowing an overlay
 * existed. Applying it at the rendered-text layer instead would mean matching
 * headings with a regex, which is how a customisation quietly eats the section
 * next to the one it meant.
 *
 * **Append is the default; replace is narrow.** Appending cannot remove
 * anything the product relies on. Replacing can.
 */

/**
 * Fields an overlay may replace, and the skill field each one is.
 *
 * All three are *this team's judgment about how work is done here*, which is
 * the whole point of a local override.
 */
export const OVERRIDABLE_FIELDS = {
  role: 'role',
  task: 'task',
  'self-verification': 'self_verification',
} as const satisfies Readonly<Record<string, keyof CanonicalSkill>>;

export type OverridableField = keyof typeof OVERRIDABLE_FIELDS;

/**
 * What an overlay may not touch, and why each one.
 *
 * These are not the "important" parts — they are the parts something
 * downstream *parses*. Replacing them does not weaken a prompt, it breaks the
 * contract between the prompt and the machinery reading its result, and it
 * breaks it silently: the run completes, the output does not match, and the
 * failure surfaces as a schema rejection nobody connects to a file somebody
 * edited last month.
 */
export const PROTECTED_FIELDS: Readonly<Record<string, string>> = {
  constitution:
    'the MUST-level rules are not local policy — overriding them locally is how a constitution stops being one',
  'context-pack':
    'assembled by the daemon per stage profile; a hand-written replacement is a pack nothing budgeted or provenanced',
  'output-contract':
    'the daemon parses the result against this schema — replace it and the run completes while nothing can read what it produced',
  'stop-condition': 'the depth cap and halt rule; a run that cannot stop is not a customisation',
  verify:
    'the daemon runs this command, not the agent — a local rewrite is a gate marking its own homework',
};

export const PromptOverrideSchema = z.object({
  /** The canonical skill this overlays, by name. */
  skill: z.string().min(1),
  /** Added after every section. The common case, and the safe one. */
  prompt_append: z.string().min(1).optional(),
  prompt_replace: z.record(z.string(), z.string().min(1)).optional(),
});
export type PromptOverride = z.infer<typeof PromptOverrideSchema>;

export interface OverrideResult {
  readonly skill: CanonicalSkill;
  /** What the overlay actually changed, in the order it changed it. */
  readonly applied: readonly string[];
  /** What it asked for and did not get, each with the reason. */
  readonly refusals: readonly string[];
}

/**
 * Applies an overlay to a canonical skill.
 *
 * Pure, and **never throws on a bad overlay**. A refused replacement leaves the
 * canonical field standing and says so; failing the whole compile instead would
 * mean one stale override file stops every skill from building, and the
 * response to that is always to delete the check.
 */
export function overrideSkill(
  skill: CanonicalSkill,
  override: PromptOverride | null,
): OverrideResult {
  if (override === null) return { skill, applied: [], refusals: [] };

  const applied: string[] = [];
  const refusals: string[] = [];
  const patch: Record<string, string> = {};

  for (const [name, text] of Object.entries(override.prompt_replace ?? {})) {
    const protectedWhy = PROTECTED_FIELDS[name];
    if (protectedWhy !== undefined) {
      refusals.push(`cannot replace \`${name}\` — ${protectedWhy}`);
      continue;
    }
    const field = OVERRIDABLE_FIELDS[name as OverridableField];
    if (field === undefined) {
      refusals.push(
        `\`${name}\` is not replaceable — the replaceable parts are ${Object.keys(OVERRIDABLE_FIELDS).join(', ')}`,
      );
      continue;
    }
    patch[field] = text;
    applied.push(`replaced ${name}`);
  }

  if (override.prompt_append !== undefined) {
    patch['prompt_append'] = override.prompt_append;
    applied.push('appended local text');
  }

  if (applied.length === 0) return { skill, applied, refusals };
  return { skill: { ...skill, ...patch }, applied, refusals };
}

/** Where overlays live, beside `docs/gates/` and `docs/views/` and for the same reason. */
export const PROMPTS_DIR = 'prompts';

export function formatOverride(result: OverrideResult): string {
  if (result.applied.length === 0 && result.refusals.length === 0) {
    return 'no local prompt override';
  }
  return [
    ...result.applied.map((entry) => `  ✓ ${entry}`),
    ...result.refusals.map((entry) => `  ✗ ${entry}`),
  ].join('\n');
}
