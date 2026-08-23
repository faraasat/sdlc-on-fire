import { CanonicalSkillSchema, LIFECYCLE_STAGES } from '@sdlc-on-fire/core';
import { describe, expect, it } from 'vitest';
import { ClaudeCodeAdapter } from '../adapters/claude-code.js';
import { runDoctor } from '../doctor.js';
import { renderPromptTemplate } from '../prompt.js';
import {
  CANONICAL_SKILLS,
  getSkill,
  skillForStage,
  skillForSituation,
  IMPLEMENT_SKILL,
  SPEC_SKILL,
} from './canonical.js';
import { RETROSPECTIVE_SKILL } from './retrospective.js';

const skills = Object.values(CANONICAL_SKILLS);

describe('canonical skills', () => {
  it('ships exactly the skills it claims to', () => {
    // spec + implement (P1-SKILL-01), review (P1-SKILL-02), retrospective
    // (P1-SKILL-03), resolve-conflict (P2-SKILL-07), the five planning
    // skills (P6-PAYLOAD-01), write-tests (P6-PAYLOAD-02), security-review
    // (P6-PAYLOAD-03) and the six delivery skills (P6-PAYLOAD-04). `review` was
    // once built but never registered, which made it invisible to stage
    // resolution — hence this census, and hence updating it deliberately rather
    // than letting it drift.
    expect(Object.keys(CANONICAL_SKILLS).sort()).toEqual([
      'architecture',
      'capture',
      'decompose',
      'discovery',
      'implement',
      'implementation-planning',
      'import',
      'new-project',
      'plan-story',
      'pr',
      'release-notes',
      'research',
      'resolve-conflict',
      'retrospective',
      'review',
      'security-review',
      'spec',
      'triage-bug',
      'triage-capture',
      'ui-explore',
      'write-tests',
    ]);
  });

  it('maps each stage skill to a distinct stage', () => {
    // skillForStage resolves by the skill's own stage field, so two skills
    // claiming one stage would make dispatch order-dependent. Situational
    // skills have no stage and are excluded rather than counted as a
    // collision on `undefined`.
    const stages = skills.map((skill) => skill.stage).filter((stage) => stage !== undefined);
    expect(new Set(stages).size).toBe(stages.length);
  });

  it('gives every skill exactly one trigger', () => {
    // Contract 04 §2.1. None means nothing dispatches it; more than one means it
    // claims several and which wins is decided by whichever code path reads it.
    for (const skill of skills) {
      const triggers = [skill.stage, skill.situation, skill.user_invoked].filter(
        (v) => v !== undefined,
      );
      expect(triggers.length, skill.name).toBe(1);
    }
  });

  it('keeps the user-invoked set closed', () => {
    // `user_invoked` is the trigger with no detector behind it, which makes it
    // the one a skill reaches for when its dispatch was never thought through.
    // A census, like SKILL_STAGES_OUTSIDE_LIFECYCLE, so adding one is an edit a
    // reviewer sees rather than a field somebody quietly sets (P6-PAYLOAD-04).
    const invoked = skills.filter((skill) => skill.user_invoked === true).map((s) => s.name);
    expect(invoked.sort()).toEqual([
      'capture',
      'import',
      'new-project',
      'pr',
      'release-notes',
      'research',
      'triage-capture',
    ]);
  });

  it('never gives one word two dispatch paths', () => {
    // `triage` means two things here: `sdlc triage` promotes a capture, and
    // `triage` is the lifecycle stage bug and dependency-upgrade cards enter at
    // (the bug-shaped alias for the `discovery` slot). The capture skill is
    // named `triage-capture` for that reason. This pins it: four times now this
    // repository has found two copies of a vocabulary that had never been in the
    // same room, and each time the copies agreed right up until they did not.
    const byName = Object.keys(CANONICAL_SKILLS);
    expect(byName).not.toContain('triage');
    expect(LIFECYCLE_STAGES).toContain('triage');
  });

  it('resolves a situation to its skill, separately from stages', () => {
    // A merge conflict is not a lifecycle state — it happens partway through
    // `implement` and arrives without the stage changing.
    expect(skillForSituation('merge-conflict')?.name).toBe('resolve-conflict');
    expect(skillForStage('merge-conflict')).toBeUndefined();
    expect(skillForSituation('implement')).toBeUndefined();
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

  it('compiles slots into the substitution the target performs', () => {
    const content = adapter.compileSkill(SPEC_SKILL).files[0]?.content ?? '';
    // Was `toContain('{{work_item_id}}')`, on the belief that the surface fills
    // our slot syntax at invocation. It does not — Claude Code substitutes
    // `$ARGUMENTS[N]`, so the verbatim slot reached the model as literal text.
    expect(content).toContain('$ARGUMENTS[0]');
    expect(content).not.toContain('{{');
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

describe('the retrospective skill (P1-SKILL-03)', () => {
  it('is registered and owns the retrospective stage', () => {
    expect(skillForStage('retrospective')?.name).toBe('retrospective');
  });

  it('caps the output at one entry, and permits zero', () => {
    // The failure mode of a memory store is accumulation, not scarcity: a wrong
    // remembered fact is retrieved with the same confidence as a right one.
    expect(RETROSPECTIVE_SKILL.task).toMatch(/at most one/i);
    expect(RETROSPECTIVE_SKILL.task).toMatch(/emit an empty entry/i);
    expect(RETROSPECTIVE_SKILL.stop_condition).toMatch(/one memory entry/i);
  });

  it('forces a durability test before emitting', () => {
    expect(RETROSPECTIVE_SKILL.self_verification).toMatch(/six months/i);
    expect(RETROSPECTIVE_SKILL.self_verification).toMatch(/from the diff alone/i);
  });

  it('does not let itself open follow-up work or advance the lifecycle', () => {
    // A retrospective that files tasks is a planning stage wearing a
    // retrospective's name.
    expect(RETROSPECTIVE_SKILL.stop_condition).toMatch(/not open follow-up/i);
    expect(RETROSPECTIVE_SKILL.role).toMatch(/do not advance the lifecycle/i);
  });
});
