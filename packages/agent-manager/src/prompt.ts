import { PROMPT_SECTION_ORDER, type CanonicalSkill, type PromptSection } from '@sdlc-on-fire/core';

/**
 * Stage-skill prompt assembly, per contracts/04-skill-ir.md §2.3 and ADR-0018.
 *
 * v0.1 ships the minimal template the mvp-slice calls for —
 * role → constitution → context → task → output-contract → verify/stop. The full
 * meta-prompting repertoire and the prompt regression suite are v0.2.
 *
 * The section order is **not** a formatting preference: it is the
 * `stableUpToIndex` cache-boundary decision (ADR-0018, contracts/05). Stable
 * sections come first so a repeat invocation of the same skill can reuse the
 * cached prefix; anything per-invocation must come after, and must never be
 * interleaved earlier.
 */

export class UnresolvedSlotError extends Error {
  override readonly name = 'UnresolvedSlotError';
  constructor(readonly slots: readonly string[]) {
    super(
      `prompt template has unresolved slots: ${slots.join(', ')}. ` +
        'Emitting a literal {{slot}} to a model is worse than failing — it reads as instruction.',
    );
  }
}

/** Sections whose content is identical across invocations of the same skill. */
export const STABLE_SECTIONS: readonly PromptSection[] = [
  'role',
  'constitution',
  'output-contract',
  'self-verification',
  'stop-condition',
];

export interface PromptSlots {
  /** Resolved constitution text for this stage — never the whole constitution. */
  readonly constitution?: string | undefined;
  /** The assembled context pack's rendered content. */
  readonly context?: string | undefined;
  /** Worked examples, when the skill body carries them. */
  readonly examples?: string | undefined;
  /** Values substituted into `{{slot}}` variables in the task template. */
  readonly variables?: Record<string, string> | undefined;
}

export interface RenderedPrompt {
  readonly text: string;
  /** Sections in emitted order, so a caller can locate the cache breakpoint. */
  readonly sections: readonly { kind: PromptSection; content: string }[];
  /**
   * Inclusive index up to which content is identical across invocations of this
   * skill. `-1` when nothing is stable.
   */
  readonly stableUpToIndex: number;
}

const SLOT_PATTERN = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

/**
 * Substitutes `{{slot}}` variables, failing on anything left unresolved.
 *
 * Deliberately strict: a literal `{{task_id}}` reaching a model reads as an
 * instruction to invent one, which is exactly the class of silent-garbage error
 * a prompt template should make impossible.
 */
export function fillSlots(template: string, variables: Record<string, string> = {}): string {
  const unresolved = new Set<string>();
  const filled = template.replace(SLOT_PATTERN, (match, name: string) => {
    const value = variables[name];
    if (value === undefined) {
      unresolved.add(name);
      return match;
    }
    return value;
  });
  if (unresolved.size > 0) throw new UnresolvedSlotError([...unresolved]);
  return filled;
}

function sectionContent(
  kind: PromptSection,
  skill: CanonicalSkill,
  slots: PromptSlots,
): string | null {
  switch (kind) {
    case 'role':
      return skill.role;
    case 'constitution':
      return slots.constitution ?? null;
    case 'context-pack':
      return slots.context ?? null;
    case 'task':
      return fillSlots(skill.task, slots.variables);
    case 'examples':
      return slots.examples ?? null;
    case 'output-contract':
      // Names the tool and points at the schema — never prose describing a shape.
      return [
        `Emit your result by calling the \`${skill.output_contract.tool_name}\` tool.`,
        `Its arguments must validate against \`${skill.output_contract.json_schema_ref}\`.`,
        'Do not emit the result as prose.',
      ].join('\n');
    case 'self-verification':
      return skill.self_verification ?? null;
    case 'stop-condition':
      return skill.stop_condition;
  }
}

const SECTION_HEADING: Record<PromptSection, string> = {
  role: 'Role',
  constitution: 'Constitution (this stage)',
  'context-pack': 'Context',
  task: 'Task',
  examples: 'Examples',
  'output-contract': 'Output contract',
  'self-verification': 'Before you emit',
  'stop-condition': 'Stop condition',
};

/**
 * Renders a skill into its prompt text.
 *
 * Sections with no content are omitted rather than emitted empty — a heading
 * with nothing under it invites a model to fill the gap.
 */
export function renderPrompt(skill: CanonicalSkill, slots: PromptSlots = {}): RenderedPrompt {
  return render(skill, slots, true);
}

/**
 * Renders the **template** form, leaving `{{slot}}` variables in place.
 *
 * This is what gets compiled into an agent surface's SKILL.md: the file is a
 * template the surface fills at invocation, so slots must survive compilation.
 * Kept as a separate entry point rather than a flag on {@link renderPrompt},
 * because "unresolved slots are fine here" must be an explicit choice at the
 * call site and never a default that leaks into runtime rendering.
 */
export function renderPromptTemplate(
  skill: CanonicalSkill,
  slots: PromptSlots = {},
): RenderedPrompt {
  return render(skill, slots, false);
}

function render(skill: CanonicalSkill, slots: PromptSlots, strictSlots: boolean): RenderedPrompt {
  const sections: { kind: PromptSection; content: string }[] = [];

  for (const kind of PROMPT_SECTION_ORDER) {
    const content =
      kind === 'task' && !strictSlots ? skill.task : sectionContent(kind, skill, slots);
    if (content !== null && content.trim().length > 0) {
      sections.push({ kind, content: content.trim() });
    }
  }

  // The boundary is the last emitted section before the first volatile one.
  // Computed from what was actually emitted, not from the canonical order, so an
  // omitted optional section cannot shift the breakpoint past volatile content.
  let stableUpToIndex = -1;
  for (const [index, section] of sections.entries()) {
    if (!STABLE_SECTIONS.includes(section.kind)) break;
    stableUpToIndex = index;
  }

  const text = sections
    .map((section) => `## ${SECTION_HEADING[section.kind]}\n\n${section.content}`)
    .join('\n\n');

  return { text, sections, stableUpToIndex };
}
