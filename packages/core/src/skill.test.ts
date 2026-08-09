import { describe, expect, it } from 'vitest';
import { CanonicalSkillSchema, PROMPT_SECTION_ORDER, SKILL_STAGES } from './skill.js';

function skill(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: '0.1.0',
    name: 'implement',
    description: 'Implement a scoped task against its linked spec.',
    stage: 'implement',
    tier: 'medium',
    context_pack_spec_ref: 'context-packs/implement.yaml',
    role: 'You are the Implementer agent.',
    constitution_excerpt_ref: 'constitution#engineering-principles',
    task: 'Implement {{task_id}}.',
    output_contract: {
      tool_name: 'implement_output',
      json_schema_ref: 'schemas/implement-output.schema.json',
    },
    stop_condition: 'Stop after one implementation report is emitted.',
    verify: { command_template: 'pnpm test', done_criteria_ref: 'task#done' },
    ...overrides,
  };
}

describe('canonical skill schema', () => {
  it('accepts a well-formed skill and defaults context_mode to inline', () => {
    const parsed = CanonicalSkillSchema.parse(skill());
    expect(parsed.context_mode).toBe('inline');
  });

  it('requires kebab-case names', () => {
    expect(CanonicalSkillSchema.safeParse(skill({ name: 'Implement Thing' })).success).toBe(false);
    expect(CanonicalSkillSchema.safeParse(skill({ name: 'plan-story' })).success).toBe(true);
  });

  it('requires a snake_case tool_name', () => {
    expect(
      CanonicalSkillSchema.safeParse(
        skill({ output_contract: { tool_name: 'implementOutput', json_schema_ref: 'x' } }),
      ).success,
    ).toBe(false);
  });

  it('requires semver on schema_version', () => {
    expect(CanonicalSkillSchema.safeParse(skill({ schema_version: '0.1' })).success).toBe(false);
  });

  it('rejects a model id in place of a tier', () => {
    // A skill naming a model goes stale on every provider release (ADR-0028).
    expect(CanonicalSkillSchema.safeParse(skill({ tier: 'claude-opus-5' })).success).toBe(false);
  });
});

describe('review skills must self-verify', () => {
  it('rejects a review skill with no self_verification', () => {
    // A review that can pass silently is the failure adversarial review exists
    // to prevent.
    const result = CanonicalSkillSchema.safeParse(skill({ stage: 'review' }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes('self_verification'))).toBe(true);
    }
  });

  it('accepts one that declares it', () => {
    expect(
      CanonicalSkillSchema.safeParse(
        skill({ stage: 'review', self_verification: 'HALT if zero findings.' }),
      ).success,
    ).toBe(true);
  });

  it('does not require it on non-review stages', () => {
    for (const stage of SKILL_STAGES.filter((s) => s !== 'review')) {
      expect(CanonicalSkillSchema.safeParse(skill({ stage })).success, stage).toBe(true);
    }
  });
});

describe('tool grants', () => {
  it('rejects a tool that is both allowed and disallowed', () => {
    // Resolving this either way would be a security-relevant guess.
    const result = CanonicalSkillSchema.safeParse(
      skill({ allowed_tools: ['Bash', 'Read'], disallowed_tools: ['Bash'] }),
    );
    expect(result.success).toBe(false);
  });

  it('accepts disjoint grants', () => {
    expect(
      CanonicalSkillSchema.safeParse(skill({ allowed_tools: ['Read'], disallowed_tools: ['Bash'] }))
        .success,
    ).toBe(true);
  });
});

describe('arguments', () => {
  it('rejects duplicate names', () => {
    expect(
      CanonicalSkillSchema.safeParse(
        skill({
          arguments: [
            { name: 'task-id', required: true },
            { name: 'task-id', required: false },
          ],
        }),
      ).success,
    ).toBe(false);
  });

  it('rejects a required argument after an optional one', () => {
    // It could never be bound positionally.
    expect(
      CanonicalSkillSchema.safeParse(
        skill({
          arguments: [
            { name: 'a', required: false },
            { name: 'b', required: true },
          ],
        }),
      ).success,
    ).toBe(false);
  });

  it('accepts required-then-optional', () => {
    expect(
      CanonicalSkillSchema.safeParse(
        skill({
          arguments: [
            { name: 'a', required: true },
            { name: 'b', required: false },
          ],
        }),
      ).success,
    ).toBe(true);
  });
});

describe('prompt section order', () => {
  it('puts stable sections before volatile ones', () => {
    // This order IS the cache-boundary decision (ADR-0018), not a separate one.
    const order = PROMPT_SECTION_ORDER;
    expect(order.indexOf('role')).toBeLessThan(order.indexOf('task'));
    expect(order.indexOf('constitution')).toBeLessThan(order.indexOf('task'));
    expect(order.indexOf('output-contract')).toBeLessThan(order.indexOf('stop-condition'));
  });
});
