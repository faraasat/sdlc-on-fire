import { describe, expect, it } from 'vitest';
import { CANONICAL_SKILLS, skillForStage } from './canonical.js';
import { OUTPUT_SCHEMAS, resolveOutputSchema } from './output-schemas.js';
import {
  ARCHITECTURE_SKILL,
  DECOMPOSE_SKILL,
  DISCOVERY_SKILL,
  IMPLEMENTATION_PLANNING_SKILL,
  PLAN_STORY_SKILL,
} from './planning.js';

const PLANNING = [
  DISCOVERY_SKILL,
  DECOMPOSE_SKILL,
  PLAN_STORY_SKILL,
  ARCHITECTURE_SKILL,
  IMPLEMENTATION_PLANNING_SKILL,
];

describe('the planning skills are reachable, not merely written', () => {
  it.each(PLANNING.map((s) => [s.name, s]))('%s is in CANONICAL_SKILLS', (name, skill) => {
    // A skill absent from the registry is invisible to `skillForStage`, so its
    // stage reports "no skill available" while the skill sits in a file two
    // directories away. That has happened here before.
    expect(CANONICAL_SKILLS[name]).toBe(skill);
  });

  it('every stage-bound planning skill is what its stage resolves to', () => {
    expect(skillForStage('discovery')).toBe(DISCOVERY_SKILL);
    expect(skillForStage('decompose')).toBe(DECOMPOSE_SKILL);
    // The stage is `plan` — the lifecycle's word. The *skill* is named
    // `plan-story`; name and stage are different fields, and conflating them is
    // what made this skill unreachable when it first landed.
    expect(skillForStage('plan')).toBe(PLAN_STORY_SKILL);
  });

  it('situational skills are never returned by skillForStage', () => {
    // Structural, not a convention: `skillForStage` matches on `stage`, and
    // these have none. An architecture pass in front of every one-line bug fix
    // is the failure this prevents.
    const stages = ['discovery', 'spec', 'decompose', 'plan', 'implement', 'review'] as const;
    for (const stage of stages) {
      expect(skillForStage(stage)?.name).not.toBe('architecture');
      expect(skillForStage(stage)?.name).not.toBe('implementation-planning');
    }
  });

  it('each situation is named for its trigger, not for the skill', () => {
    // A situation called `architecture` says only "this is when the
    // architecture skill runs" — circular, and silent about when it fires.
    expect(ARCHITECTURE_SKILL.situation).toBe('crosses-module-boundary');
    expect(IMPLEMENTATION_PLANNING_SKILL.situation).toBe('oversized-story');
  });
});

describe('every planning skill can be dispatched', () => {
  it.each(PLANNING.map((s) => [s.name, s]))('%s resolves its output schema', (_name, skill) => {
    // A ref pointing at nothing produces a skill that lists and cannot be called.
    expect(resolveOutputSchema(skill.output_contract.json_schema_ref)).toBeDefined();
  });

  it('no registered skill references a schema that is absent', () => {
    for (const skill of Object.values(CANONICAL_SKILLS)) {
      expect(OUTPUT_SCHEMAS[skill.output_contract.json_schema_ref]).toBeDefined();
    }
  });

  it('tool names are unique across the whole registry', () => {
    const names = Object.values(CANONICAL_SKILLS).map((s) => s.output_contract.tool_name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('no planning skill grades itself', () => {
  it.each(PLANNING.map((s) => [s.name, s]))('%s refuses to advance the lifecycle', (_n, skill) => {
    // The daemon moves state when evidence says it may. A skill that advanced
    // its own stage would be grading itself — the thing this product refuses.
    // Matched on the property, not on an exact phrase. The first version of
    // this demanded a contiguous "do not advance the stage" and failed on
    // "…, or advance the stage", where the negation sits earlier in the
    // sentence — a test that pins wording rather than meaning gets loosened by
    // whoever next rephrases a prompt, and stops checking anything.
    expect(`${skill.role} ${skill.stop_condition}`).toMatch(
      /\b(?:not|never)\b[^.]{0,80}\badvance the (?:lifecycle )?(?:stage|state)\b/i,
    );
  });

  it.each(PLANNING.map((s) => [s.name, s]))('%s declares where it stops', (_n, skill) => {
    expect(skill.stop_condition.length).toBeGreaterThan(20);
  });
});

describe('a planning skill can report that it could not plan', () => {
  it.each(PLANNING.map((s) => [s.name, s]))('%s output allows blocked_on', (_n, skill) => {
    // Without an escape hatch a planning skill invents the plan — and an
    // invented plan is worse than an absent one, because it looks like work.
    const schema = resolveOutputSchema(skill.output_contract.json_schema_ref);
    const parsed = schema?.safeParse({
      work_item_id: 'X-1',
      blocked_on: ['the spec has no criteria'],
    });
    // It may fail on other required fields, but never because `blocked_on` is
    // unrecognised — these schemas are `.strict()`.
    const issues = parsed?.success === false ? JSON.stringify(parsed.error.issues) : '';
    expect(issues).not.toMatch(/blocked_on/);
  });
});

describe('the schemas keep apart what a reader must be able to tell apart', () => {
  it('discovery separates what it was told from what it inferred', () => {
    const schema = resolveOutputSchema('schemas/discovery-output.schema.json');
    const ok = schema?.safeParse({
      work_item_id: 'X-1',
      problem: 'p',
      affected: [{ who: 'ops', evidence: 'ticket 12' }],
      constraints: [{ constraint: 'must stay on PG 14', source: 'infra' }],
      open_questions: [],
      inferred: ['probably nightly'],
    });
    expect(ok?.success).toBe(true);
  });

  it('an architecture decision must name a rejected alternative and a reversal condition', () => {
    const schema = resolveOutputSchema('schemas/architecture-output.schema.json');
    const missing = schema?.safeParse({
      work_item_id: 'X-1',
      boundaries: [{ module: 'core', owns: 'schemas' }],
      decisions: [{ decision: 'use a queue' }],
    });
    // A decision with no stated alternative was not a decision.
    expect(missing?.success).toBe(false);
  });

  it('decompose requires each child to carry its own verify command', () => {
    const schema = resolveOutputSchema('schemas/decompose-output.schema.json');
    const missing = schema?.safeParse({
      work_item_id: 'X-1',
      children: [{ title: 't', kind: 'task', acceptance_criteria: ['a'], traces_to: 'AC-1' }],
    });
    expect(missing?.success).toBe(false);
  });
});
