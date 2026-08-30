import { describe, expect, it } from 'vitest';
import {
  formatOverride,
  overrideSkill,
  OVERRIDABLE_FIELDS,
  PROMPT_SECTION_ORDER,
  PROTECTED_FIELDS,
  PromptOverrideSchema,
  type CanonicalSkill,
} from './index.js';

const skill = {
  schema_version: '1.0.0',
  name: 'implement',
  description: 'do the work',
  stage: 'implement',
  tier: 'medium',
  context_pack_spec_ref: 'specs/implement.yaml',
  role: 'canonical role',
  constitution_excerpt_ref: 'docs/constitution.md#implement',
  task: 'canonical task',
  output_contract: { tool_name: 'implement_output', json_schema_ref: 'schemas/i.json' },
  self_verification: 'canonical self-check',
  stop_condition: 'canonical stop',
  verify: { command_template: 'pnpm test', done_criteria_ref: 'docs/dod.md' },
  context_mode: 'inline',
} as CanonicalSkill;

describe('overrideSkill', () => {
  it('changes nothing without an overlay', () => {
    const result = overrideSkill(skill, null);
    expect(result.skill).toBe(skill);
    expect(result.applied).toEqual([]);
  });

  it('appends local text as a field the renderer already knows', () => {
    const result = overrideSkill(skill, { skill: 'implement', prompt_append: 'we use tabs' });
    expect(result.skill.prompt_append).toBe('we use tabs');
    expect(result.applied).toEqual(['appended local text']);
  });

  it('leaves the canonical skill untouched — the overlay produces a copy', () => {
    overrideSkill(skill, { skill: 'implement', prompt_append: 'x' });
    expect(skill.prompt_append).toBeUndefined();
  });

  it('replaces the fields a team is entitled to', () => {
    const result = overrideSkill(skill, {
      skill: 'implement',
      prompt_replace: { role: 'our role', task: 'our task', 'self-verification': 'our check' },
    });
    expect(result.skill.role).toBe('our role');
    expect(result.skill.task).toBe('our task');
    expect(result.skill.self_verification).toBe('our check');
    expect(result.refusals).toEqual([]);
  });

  it.each(Object.keys(PROTECTED_FIELDS))('refuses to replace %s', (field) => {
    const result = overrideSkill(skill, {
      skill: 'implement',
      prompt_replace: { [field]: 'mine now' },
    });
    expect(result.refusals).toHaveLength(1);
    // And the canonical value is still standing.
    expect(result.skill).toBe(skill);
  });

  it('says why the output contract is protected, not just that it is', () => {
    const result = overrideSkill(skill, {
      skill: 'implement',
      prompt_replace: { 'output-contract': 'just say ok' },
    });
    expect(result.refusals[0]).toContain('the daemon parses');
  });

  it('refuses a field that is not a field at all', () => {
    const result = overrideSkill(skill, {
      skill: 'implement',
      prompt_replace: { taks: 'typo' },
    });
    expect(result.refusals[0]).toContain('not replaceable');
    expect(result.refusals[0]).toContain('task');
  });

  it('keeps the replacements it can while refusing the ones it cannot', () => {
    // The important shape: one bad key does not throw the good ones away.
    const result = overrideSkill(skill, {
      skill: 'implement',
      prompt_replace: { role: 'ours', 'stop-condition': 'never stop' },
    });
    expect(result.skill.role).toBe('ours');
    expect(result.skill.stop_condition).toBe('canonical stop');
    expect(result.applied).toEqual(['replaced role']);
    expect(result.refusals).toHaveLength(1);
  });

  it('keeps a good replacement alongside an unrecognised key, too', () => {
    // The other refusal branch. Both `continue`s have to keep going, and only
    // a mixed overlay can tell an early return from a correct one.
    const result = overrideSkill(skill, {
      skill: 'implement',
      prompt_replace: { role: 'ours', taks: 'typo' },
    });
    expect(result.skill.role).toBe('ours');
    expect(result.applied).toEqual(['replaced role']);
    expect(result.refusals).toHaveLength(1);
  });

  it('never throws, whatever the overlay says', () => {
    expect(() =>
      overrideSkill(skill, {
        skill: 'implement',
        prompt_replace: { verify: 'echo ok', nonsense: 'x' },
      }),
    ).not.toThrow();
  });
});

describe('the boundary between overridable and protected', () => {
  it('shares no names — a field cannot be both', () => {
    for (const name of Object.keys(OVERRIDABLE_FIELDS)) {
      expect(PROTECTED_FIELDS[name]).toBeUndefined();
    }
  });

  it('protects everything the daemon parses', () => {
    // Named individually: adding one of these to the overridable set would let
    // a workspace break its own gate without any error at compile time.
    for (const parsed of ['output-contract', 'stop-condition', 'verify', 'constitution']) {
      expect(PROTECTED_FIELDS[parsed]).toBeTruthy();
    }
  });

  it('gives every protected field a reason, not just a flag', () => {
    for (const why of Object.values(PROTECTED_FIELDS)) {
      expect(why.length).toBeGreaterThan(20);
    }
  });
});

describe('the local-append section', () => {
  it('is last — the order is the prompt-cache boundary', () => {
    expect(PROMPT_SECTION_ORDER[PROMPT_SECTION_ORDER.length - 1]).toBe('local-append');
  });
});

describe('PromptOverrideSchema', () => {
  it('rejects an empty append rather than storing a blank section', () => {
    expect(PromptOverrideSchema.safeParse({ skill: 'implement', prompt_append: '' }).success).toBe(
      false,
    );
  });

  it('accepts an overlay that only replaces', () => {
    expect(
      PromptOverrideSchema.safeParse({ skill: 'x', prompt_replace: { role: 'r' } }).success,
    ).toBe(true);
  });
});

describe('formatOverride', () => {
  it('says so when there is nothing to report', () => {
    expect(formatOverride(overrideSkill(skill, null))).toBe('no local prompt override');
  });

  it('marks applied and refused differently', () => {
    const text = formatOverride(
      overrideSkill(skill, {
        skill: 'implement',
        prompt_append: 'x',
        prompt_replace: { verify: 'y' },
      }),
    );
    expect(text).toContain('✓');
    expect(text).toContain('✗');
  });
});
