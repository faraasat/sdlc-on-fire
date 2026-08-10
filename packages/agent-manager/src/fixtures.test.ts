import { describe, expect, it } from 'vitest';
import {
  runFixtures,
  SkillFixtureSchema,
  unfixturedSkills,
  type SkillFixture,
} from './fixtures.js';
import { SPEC_SKILL, CANONICAL_SKILLS } from './skills/canonical.js';

/**
 * Skill regression fixtures (P0-EVAL-01, ADR-0042).
 *
 * Prompts are code with no compiler. The only thing that makes editing one safe
 * is a harness that replays known inputs and checks the output contract still
 * holds — which is why ADR-0042 says a skill without fixtures is not active.
 */

const fixture = (over: Partial<SkillFixture>): SkillFixture =>
  SkillFixtureSchema.parse({
    name: 'baseline',
    recordedOutput: `spec_output ${JSON.stringify({
      title: 'CSV export',
      acceptance_criteria: ['GIVEN a table WHEN export THEN a .csv is written'],
    })}`,
    assertions: [{ path: 'title', equals: 'CSV export' }],
    ...over,
  });

describe('replaying a fixture', () => {
  it('passes when the recorded output still satisfies the contract', () => {
    const result = runFixtures(SPEC_SKILL, [fixture({})]);
    expect(result.ok).toBe(true);
    expect(result.ran).toBe(1);
  });

  it('fails with the actual value, not just "assertion failed"', () => {
    const result = runFixtures(SPEC_SKILL, [
      fixture({ assertions: [{ path: 'title', equals: 'Something else' }] }),
    ]);
    expect(result.ok).toBe(false);
    expect(result.failures[0]?.reason).toContain('CSV export');
  });

  it('checks presence separately from equality', () => {
    // An empty array is present-but-useless; the distinction matters for a
    // field like acceptance_criteria.
    const empty = `spec_output ${JSON.stringify({ title: 'x', acceptance_criteria: [] })}`;
    const result = runFixtures(SPEC_SKILL, [
      fixture({
        recordedOutput: empty,
        assertions: [{ path: 'acceptance_criteria', present: true }],
      }),
    ]);
    expect(result.ok).toBe(false);
    expect(result.failures[0]?.reason).toMatch(/absent or empty/);
  });

  it('reaches into nested paths', () => {
    const result = runFixtures(SPEC_SKILL, [
      fixture({ assertions: [{ path: 'acceptance_criteria.0', contains: 'GIVEN' }] }),
    ]);
    expect(result.ok).toBe(true);
  });

  it('runs through the real extraction path, so prose is rejected as it would be live', () => {
    // A harness that parsed the output itself would pass while production
    // failed — the same defect runDoctor avoids by compiling for real.
    const result = runFixtures(SPEC_SKILL, [
      fixture({ recordedOutput: 'I had a think about it and here are my notes.' }),
    ]);
    expect(result.ok).toBe(false);
    expect(result.failures[0]?.reason).toMatch(/rejected/);
  });
});

describe('fixtures that pin a rejection', () => {
  it('passes when the output is refused for the stated reason', () => {
    // The agent-claims-its-own-tests-passed refusal is behaviour worth
    // regression-testing, not just an implementation detail.
    const lying = `spec_output ${JSON.stringify({ title: 'x', testsPassed: true })}`;
    const result = runFixtures(SPEC_SKILL, [
      fixture({
        recordedOutput: lying,
        expectsRejection: 'claims verification results',
        assertions: [{ path: 'title', present: true }],
      }),
    ]);
    expect(result.ok).toBe(true);
  });

  it('fails when the output it expected to be refused is accepted', () => {
    const result = runFixtures(SPEC_SKILL, [
      fixture({ expectsRejection: 'claims verification results' }),
    ]);
    expect(result.ok).toBe(false);
    expect(result.failures[0]?.reason).toMatch(/but it was accepted/);
  });
});

describe('the activation rule (ADR-0042)', () => {
  it('names every skill with no fixtures', () => {
    const skills = Object.values(CANONICAL_SKILLS);
    const withOne = new Map([['spec', [fixture({})]]]);
    const unfixtured = unfixturedSkills(skills, withOne);

    expect(unfixtured).not.toContain('spec');
    expect(unfixtured).toContain('implement');
    expect(unfixtured).toContain('review');
  });

  it('reports all of them at once rather than stopping at the first', () => {
    // doctor should show the whole gap in one pass.
    const skills = Object.values(CANONICAL_SKILLS);
    expect(unfixturedSkills(skills, new Map())).toHaveLength(skills.length);
  });
});
