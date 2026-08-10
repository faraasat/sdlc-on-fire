import { CanonicalSkillSchema } from '@sdlc-on-fire/core';
import { describe, expect, it } from 'vitest';
import { ClaudeCodeAdapter } from '../adapters/claude-code.js';
import { runDoctor } from '../doctor.js';
import { renderPromptTemplate } from '../prompt.js';
import {
  CANONICAL_SKILLS,
  getSkill,
  skillForStage,
  IMPLEMENT_SKILL,
  SPEC_SKILL,
} from './canonical.js';

const skills = Object.values(CANONICAL_SKILLS);

describe('canonical skills', () => {
  it('ships exactly the three v0.1 skills', () => {
    // spec + implement (P1-SKILL-01) and review (P1-SKILL-02). `review` was
    // built but never registered, which made it invisible to stage resolution.
    expect(Object.keys(CANONICAL_SKILLS).sort()).toEqual(['implement', 'review', 'spec']);
  });

  it('maps each skill to a distinct stage', () => {
    // skillForStage resolves by the skill's own stage field, so two skills
    // claiming one stage would make dispatch order-dependent.
    const stages = skills.map((skill) => skill.stage);
    expect(new Set(stages).size).toBe(stages.length);
  });

  it('resolves a stage to its skill, and leaves daemon stages unclaimed', () => {
    expect(skillForStage('review')?.name).toBe('review');
    expect(skillForStage('implement')?.name).toBe('implement');
    // The daemon runs verify and `done` is a gate outcome — neither is an agent.
    expect(skillForStage('test')).toBeUndefined();
    expect(skillForStage('done')).toBeUndefined();
  });

  it('every skill validates against the schema', () => {
    for (const skill of skills) {
      expect(CanonicalSkillSchema.safeParse(skill).success, skill.name).toBe(true);
    }
  });

  it('looks up by name', () => {
    expect(getSkill('spec')?.name).toBe('spec');
    expect(getSkill('nope')).toBeUndefined();
  });
});

describe('skills forbid the behaviours the product exists to prevent', () => {
  it('tells the implementer not to self-report test results', () => {
    // The daemon runs verify and reads the output; a self-report is not evidence.
    expect(IMPLEMENT_SKILL.self_verification).toContain('daemon runs verify');
  });

  it('forbids advancing the lifecycle from inside a skill', () => {
    for (const skill of skills) {
      expect(skill.role.toLowerCase(), skill.name).toContain('do not advance');
    }
  });

  it('gives every skill an explicit stop condition', () => {
    for (const skill of skills) {
      expect(skill.stop_condition.length, skill.name).toBeGreaterThan(0);
    }
  });

  it('scopes the implementer to its declared file ownership', () => {
    expect(IMPLEMENT_SKILL.task).toContain('file ownership');
  });

  it('tells the spec agent to report a gap rather than invent requirements', () => {
    expect(SPEC_SKILL.role).toContain('inventing requirements is worse');
  });
});

describe('compilation', () => {
  const adapter = new ClaudeCodeAdapter();

  it('every skill compiles cleanly for Claude Code', () => {
    const report = runDoctor({ skills, adapters: [adapter] });
    expect(report.ok).toBe(true);
  });

  it('compiled output keeps slots for invocation-time filling', () => {
    const content = adapter.compileSkill(SPEC_SKILL).files[0]?.content ?? '';
    expect(content).toContain('{{work_item_id}}');
  });

  it('renders a template with the sections in canonical order', () => {
    const rendered = renderPromptTemplate(IMPLEMENT_SKILL);
    const kinds = rendered.sections.map((s) => s.kind);
    expect(kinds.indexOf('role')).toBeLessThan(kinds.indexOf('task'));
    expect(kinds).toContain('output-contract');
    expect(kinds).toContain('stop-condition');
  });
});

describe('deprecation surfaced by doctor (P0-AGENT-05, ADR-0034)', () => {
  const deprecate = (removal_tier: 'warn' | 'error' | 'removed', replacement?: string) =>
    CanonicalSkillSchema.parse({
      ...SPEC_SKILL,
      name: 'old-spec',
      deprecation: {
        deprecated_since: '0.2.0',
        removal_tier,
        ...(replacement === undefined ? {} : { replacement_ref: replacement }),
      },
    });

  const adapters = [new ClaudeCodeAdapter()];

  it('says nothing about a skill that is not deprecated', () => {
    const report = runDoctor({ skills: [SPEC_SKILL], adapters });
    expect(report.findings.filter((f) => f.field === 'deprecation')).toHaveLength(0);
  });

  it('warns without blocking at the warn tier', () => {
    const report = runDoctor({ skills: [deprecate('warn', 'spec')], adapters });
    const finding = report.findings.find((f) => f.field === 'deprecation');
    expect(finding?.severity).toBe('warning');
    expect(finding?.message).toContain('spec');
    expect(report.ok).toBe(true);
  });

  it('blocks at the error tier', () => {
    const report = runDoctor({ skills: [deprecate('error', 'spec')], adapters });
    expect(report.findings.find((f) => f.field === 'deprecation')?.severity).toBe('error');
    expect(report.ok).toBe(false);
  });

  it('blocks a removed skill and says it should not be here at all', () => {
    const report = runDoctor({ skills: [deprecate('removed')], adapters });
    const finding = report.findings.find((f) => f.field === 'deprecation');
    expect(finding?.message).toMatch(/was removed/);
    expect(report.ok).toBe(false);
  });

  it('calls out a deprecation with nowhere to go', () => {
    // Deprecating with no replacement leaves callers stranded; that is itself
    // a defect worth naming rather than a silent omission.
    const finding = runDoctor({ skills: [deprecate('warn')], adapters }).findings.find(
      (f) => f.field === 'deprecation',
    );
    expect(finding?.message).toMatch(/No replacement is declared/);
  });

  it('reports a deprecation once, not once per adapter', () => {
    // Three adapters reporting the same retirement three times teaches people
    // to skim past the report.
    const report = runDoctor({
      skills: [deprecate('warn', 'spec')],
      adapters: [new ClaudeCodeAdapter(), new ClaudeCodeAdapter()],
    });
    expect(report.findings.filter((f) => f.field === 'deprecation')).toHaveLength(1);
  });
});
