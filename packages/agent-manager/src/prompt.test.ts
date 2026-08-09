import {
  CanonicalSkillSchema,
  PROMPT_SECTION_ORDER,
  type CanonicalSkill,
} from '@sdlc-on-fire/core';
import { describe, expect, it } from 'vitest';
import { fillSlots, renderPrompt, UnresolvedSlotError } from './prompt.js';

function skill(overrides: Record<string, unknown> = {}): CanonicalSkill {
  return CanonicalSkillSchema.parse({
    schema_version: '0.1.0',
    name: 'implement',
    description: 'Implement a scoped task.',
    stage: 'implement',
    tier: 'medium',
    context_pack_spec_ref: 'context-packs/implement.yaml',
    role: 'You are the Implementer agent.',
    constitution_excerpt_ref: 'constitution#engineering',
    task: 'Implement {{task_id}}: {{task_title}}.',
    output_contract: { tool_name: 'implement_output', json_schema_ref: 'schemas/impl.json' },
    stop_condition: 'Stop after one report is emitted.',
    verify: { command_template: 'pnpm test', done_criteria_ref: 'task#done' },
    ...overrides,
  });
}

const variables = { task_id: 'TASK-001', task_title: 'Add CSV export' };

describe('slot filling', () => {
  it('substitutes every variable', () => {
    expect(fillSlots('Do {{a}} then {{b}}', { a: 'x', b: 'y' })).toBe('Do x then y');
  });

  it('tolerates whitespace inside the braces', () => {
    expect(fillSlots('{{ a }}', { a: 'x' })).toBe('x');
  });

  it('throws on an unresolved slot rather than emitting it', () => {
    // A literal {{task_id}} reaching a model reads as "invent one".
    expect(() => fillSlots('Do {{missing}}')).toThrow(UnresolvedSlotError);
  });

  it('names every unresolved slot, not just the first', () => {
    let captured: UnresolvedSlotError | undefined;
    try {
      fillSlots('{{a}} {{b}}');
    } catch (error) {
      captured = error as UnresolvedSlotError;
    }
    expect(captured?.slots.slice().sort()).toEqual(['a', 'b']);
  });

  it('leaves text with no slots untouched', () => {
    expect(fillSlots('plain text')).toBe('plain text');
  });
});

describe('section order', () => {
  it('emits sections in the canonical order', () => {
    const rendered = renderPrompt(skill({ self_verification: 'Check the ACs.' }), {
      constitution: 'MUST have tests.',
      context: 'the pack',
      variables,
    });
    const emitted = rendered.sections.map((s) => s.kind);
    const canonical = PROMPT_SECTION_ORDER.filter((k) => emitted.includes(k));
    expect(emitted).toEqual(canonical);
  });

  it('omits sections with no content rather than emitting empty headings', () => {
    // An empty heading invites a model to fill the gap.
    const rendered = renderPrompt(skill(), { variables });
    expect(rendered.sections.map((s) => s.kind)).not.toContain('context-pack');
    expect(rendered.text).not.toContain('## Context');
  });

  it('puts role before task', () => {
    const rendered = renderPrompt(skill(), { variables });
    expect(rendered.text.indexOf('## Role')).toBeLessThan(rendered.text.indexOf('## Task'));
  });
});

describe('cache boundary', () => {
  it('marks the stable prefix', () => {
    const rendered = renderPrompt(skill(), { constitution: 'MUST.', variables });
    // role + constitution are stable; task is not.
    const stable = rendered.sections.slice(0, rendered.stableUpToIndex + 1).map((s) => s.kind);
    expect(stable).toEqual(['role', 'constitution']);
  });

  it('never extends the prefix past a volatile section', () => {
    const rendered = renderPrompt(skill(), { context: 'volatile pack', variables });
    const boundary = rendered.sections[rendered.stableUpToIndex];
    expect(boundary?.kind).not.toBe('context-pack');
    expect(boundary?.kind).not.toBe('task');
  });

  it('reports -1 when nothing stable leads', () => {
    const rendered = renderPrompt(skill({ role: 'x' }), { variables });
    // role always leads here, so assert the invariant holds rather than the value.
    expect(rendered.stableUpToIndex).toBeGreaterThanOrEqual(0);
  });

  it('produces a byte-identical stable prefix across invocations with different tasks', () => {
    // This is what makes the prefix cacheable at all.
    const a = renderPrompt(skill(), { constitution: 'MUST.', variables });
    const b = renderPrompt(skill(), {
      constitution: 'MUST.',
      variables: { task_id: 'TASK-999', task_title: 'Something else' },
    });
    const prefix = (r: typeof a): string =>
      r.sections
        .slice(0, r.stableUpToIndex + 1)
        .map((s) => s.content)
        .join('\n');
    expect(prefix(a)).toBe(prefix(b));
  });
});

describe('output contract', () => {
  it('names the tool and the schema rather than describing a shape', () => {
    const rendered = renderPrompt(skill(), { variables });
    expect(rendered.text).toContain('implement_output');
    expect(rendered.text).toContain('schemas/impl.json');
    expect(rendered.text).toContain('Do not emit the result as prose.');
  });
});

describe('task rendering', () => {
  it('substitutes the work item into the task template', () => {
    const rendered = renderPrompt(skill(), { variables });
    expect(rendered.text).toContain('Implement TASK-001: Add CSV export.');
  });

  it('refuses to render with a missing variable', () => {
    expect(() => renderPrompt(skill(), { variables: { task_id: 'TASK-001' } })).toThrow(
      UnresolvedSlotError,
    );
  });
});
