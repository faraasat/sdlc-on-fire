import { describe, expect, it } from 'vitest';
import {
  CanonicalSkillSchema,
  PROMPT_SECTION_ORDER,
  SKILL_SITUATIONS,
  SKILL_STAGES,
  SKILL_STAGES_OUTSIDE_LIFECYCLE,
} from './skill.js';
import { LIFECYCLE_STAGES } from './lifecycle.js';

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

describe('exactly one trigger (contract 04 §2.1, P2-SKILL-07)', () => {
  const base = {
    schema_version: '0.1.0',
    name: 'example',
    description: 'x',
    tier: 'medium',
    context_pack_spec_ref: 'context-packs/x.yaml',
    role: 'r',
    constitution_excerpt_ref: 'constitution#x',
    task: 't',
    output_contract: { tool_name: 'x_output', json_schema_ref: 'schemas/x.schema.json' },
    stop_condition: 's',
    verify: { command_template: '{{verify_command}}', done_criteria_ref: 'work-item#done' },
  };

  it('accepts a stage skill', () => {
    expect(CanonicalSkillSchema.safeParse({ ...base, stage: 'implement' }).success).toBe(true);
  });

  it('accepts a situational skill', () => {
    // A merge conflict is not a lifecycle stage: it happens partway through
    // `implement` and arrives without the stage changing at all.
    expect(CanonicalSkillSchema.safeParse({ ...base, situation: 'merge-conflict' }).success).toBe(
      true,
    );
  });

  it('refuses a skill with neither', () => {
    // Nothing dispatches it, so it is a file that can never run.
    const result = CanonicalSkillSchema.safeParse(base);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).toContain('nothing dispatches it');
  });

  it('refuses a skill claiming both', () => {
    // Which trigger wins would be decided by whichever code path read the file
    // first, rather than by anything written down.
    const result = CanonicalSkillSchema.safeParse({
      ...base,
      stage: 'implement',
      situation: 'merge-conflict',
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).toContain('never more');
  });

  it('accepts a user-invoked skill', () => {
    // Nothing dispatches these; a person asks for them by name. A third kind
    // rather than more situations, because a situation is a condition something
    // detects, and nothing computes "the user wants to start a project"
    // (contract 04 §2.1, P6-PAYLOAD-04).
    expect(CanonicalSkillSchema.safeParse({ ...base, user_invoked: true }).success).toBe(true);
  });

  it('refuses `user_invoked: false`', () => {
    // A literal, not a boolean. `false` would be a second way of saying "no
    // trigger" — indistinguishable in a diff from having thought about it, and
    // it would leave the skill undispatchable while looking declared.
    const result = CanonicalSkillSchema.safeParse({ ...base, user_invoked: false });
    expect(result.success).toBe(false);
  });

  it('refuses a user-invoked skill that also claims a stage', () => {
    const result = CanonicalSkillSchema.safeParse({
      ...base,
      stage: 'implement',
      user_invoked: true,
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).toContain('never more');
  });

  it('keeps the situation vocabulary closed', () => {
    // An open string lets a skill declare a trigger nothing dispatches — the
    // same defect the stage validation exists to prevent, through another field.
    expect(
      CanonicalSkillSchema.safeParse({ ...base, situation: 'whenever-i-feel-like-it' }).success,
    ).toBe(false);
    expect([...SKILL_SITUATIONS]).toEqual([
      'merge-conflict',
      'crosses-module-boundary',
      'oversized-story',
      'tier-unsatisfied',
      'high-risk-surface',
    ]);
  });
});

describe('the skill and lifecycle vocabularies are one vocabulary', () => {
  it('every skill stage is a lifecycle stage, or a declared exception', () => {
    // This is the check that did not exist on 2026-08-23, when SKILL_STAGES said
    // `plan-story` and LIFECYCLE_STAGES said `plan`. Nothing noticed while no
    // skill claimed that stage. The moment one did, the skill was written,
    // registered, compiled to six targets and unreachable — `skillForStage` was
    // asked for `plan` and matched on `plan-story`, and the symptom was silence.
    //
    // Fourth instance in this repository of two copies of a vocabulary that had
    // never been in the same room. This puts them in the same room.
    const lifecycle = new Set<string>(LIFECYCLE_STAGES);
    const allowed = new Set<string>(SKILL_STAGES_OUTSIDE_LIFECYCLE);
    const orphans = SKILL_STAGES.filter((s) => !lifecycle.has(s) && !allowed.has(s));
    expect(orphans).toEqual([]);
  });

  it('the exception list does not name a stage that is in the lifecycle', () => {
    // Otherwise the escape hatch quietly grows into a second vocabulary of its
    // own, which is the same failure one indirection further away.
    const lifecycle = new Set<string>(LIFECYCLE_STAGES);
    for (const stage of SKILL_STAGES_OUTSIDE_LIFECYCLE) {
      expect(lifecycle.has(stage)).toBe(false);
    }
  });

  it('the exception list only names real skill stages', () => {
    const stages = new Set<string>(SKILL_STAGES);
    for (const stage of SKILL_STAGES_OUTSIDE_LIFECYCLE) {
      expect(stages.has(stage)).toBe(true);
    }
  });
});
