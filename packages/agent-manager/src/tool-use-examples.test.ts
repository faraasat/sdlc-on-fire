import { describe, expect, it } from 'vitest';
import { CanonicalSkillSchema } from '@sdlc-on-fire/core';
import { renderPromptTemplate, renderToolUseExamples } from './prompt.js';

/**
 * Tool Use Examples (P6-SURFACE-08, FEAT-AGT-018).
 *
 * `PROMPT_SECTION_ORDER` has carried an `examples` section since ADR-0018 and
 * the renderer has had a slot for it — with nothing writing either, so the
 * section was silently absent from every prompt this product has compiled.
 */

const base = {
  schema_version: '1.0.0',
  name: 'implement',
  description: 'do the work',
  stage: 'implement',
  tier: 'medium',
  context_pack_spec_ref: 'specs/implement.yaml',
  role: 'r',
  constitution_excerpt_ref: 'docs/c.md#implement',
  task: 't',
  output_contract: { tool_name: 'implement_output', json_schema_ref: 'schemas/i.json' },
  stop_condition: 's',
  verify: { command_template: 'pnpm test', done_criteria_ref: 'docs/dod.md' },
};

const example = {
  when: 'the change is one file and the tests already cover it',
  tool: 'Edit',
  arguments: { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' },
  why: 'Edit over Write — Write would drop everything else in the file',
};

describe('the schema', () => {
  it('accepts a skill carrying worked examples', () => {
    const parsed = CanonicalSkillSchema.safeParse({ ...base, tool_use_examples: [example] });
    expect(parsed.success).toBe(true);
  });

  it('refuses an example that demonstrates a disallowed tool', () => {
    // The prompt would teach a call the runtime refuses.
    const parsed = CanonicalSkillSchema.safeParse({
      ...base,
      disallowed_tools: ['Edit'],
      tool_use_examples: [example],
    });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain('disallows');
  });

  it('refuses an example outside a declared allowlist', () => {
    const parsed = CanonicalSkillSchema.safeParse({
      ...base,
      allowed_tools: ['Read'],
      tool_use_examples: [example],
    });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain('allowed_tools');
  });

  it('treats an absent allowlist as no restriction, not as an empty one', () => {
    expect(CanonicalSkillSchema.safeParse({ ...base, tool_use_examples: [example] }).success).toBe(
      true,
    );
  });

  it('names the offending example by index', () => {
    const parsed = CanonicalSkillSchema.safeParse({
      ...base,
      disallowed_tools: ['Bash'],
      tool_use_examples: [example, { ...example, tool: 'Bash' }],
    });
    expect(parsed.error?.issues[0]?.path).toEqual(['tool_use_examples', 1, 'tool']);
  });
});

describe('rendering', () => {
  it('is nothing at all when there are none', () => {
    expect(renderToolUseExamples(undefined)).toBeNull();
    expect(renderToolUseExamples([])).toBeNull();
  });

  it('emits the arguments as real JSON, not a description of them', () => {
    const text = renderToolUseExamples([example]) ?? '';
    expect(text).toContain('"file_path": "src/a.ts"');
    expect(text).toContain(example.when);
    expect(text).toContain(example.why);
  });

  it('reaches the compiled prompt', () => {
    const skill = CanonicalSkillSchema.parse({
      ...base,
      tool_use_examples: [example],
    });
    const rendered = renderPromptTemplate(skill);
    expect(rendered.text).toContain('"file_path": "src/a.ts"');
    expect(rendered.sections.some((section) => section.kind === 'examples')).toBe(true);
  });

  it('is absent from the prompt when the skill declares none', () => {
    const skill = CanonicalSkillSchema.parse(base);
    const rendered = renderPromptTemplate(skill);
    expect(rendered.sections.some((section) => section.kind === 'examples')).toBe(false);
  });

  it('an explicit slot still wins over the skill field', () => {
    const skill = CanonicalSkillSchema.parse({
      ...base,
      tool_use_examples: [example],
    });
    const rendered = renderPromptTemplate(skill, { examples: 'caller supplied' });
    expect(rendered.text).toContain('caller supplied');
    expect(rendered.text).not.toContain('src/a.ts');
  });
});
