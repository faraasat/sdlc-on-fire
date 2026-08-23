import { describe, expect, it } from 'vitest';
import { TEST_TIERS } from '@sdlc-on-fire/core';
import { CANONICAL_SKILLS, skillForStage } from './canonical.js';
import { resolveOutputSchema } from './output-schemas.js';
import { WRITE_TESTS_SKILL } from './write-tests.js';

describe('write-tests covers the whole tier taxonomy', () => {
  it('names every tier in its task, so none is unreachable', () => {
    // FEAT-SKILL-011 asks for four skills. ADR-0044 grew the taxonomy to seven
    // tiers afterwards. Four skills against seven tiers leaves three with no way
    // to be written while looking finished — the exact shape the audit exists
    // to catch, reproduced by the work meant to close it.
    for (const tier of TEST_TIERS) {
      expect(WRITE_TESTS_SKILL.task).toContain(tier);
    }
  });

  it('takes the tier as an argument, so a new tier cannot leave a skill behind', () => {
    const tierArg = WRITE_TESTS_SKILL.arguments?.find((a) => a.name === 'tier');
    expect(tierArg?.required).toBe(true);
  });

  it('accepts every tier in the taxonomy and nothing else', () => {
    const schema = resolveOutputSchema('schemas/write-tests-output.schema.json');
    for (const tier of TEST_TIERS) {
      const ok = schema?.safeParse({
        work_item_id: 'X-1',
        tier,
        tests: [{ file: 'a.test.ts', name: 't', catches: 'returning null' }],
      });
      expect(ok?.success, tier).toBe(true);
    }
    const bad = schema?.safeParse({ work_item_id: 'X-1', tier: 'vibes', tests: [] });
    expect(bad?.success).toBe(false);
  });
});

describe('write-tests never grades its own work', () => {
  it('is situational, so it is not what the test stage dispatches', () => {
    // The `test` lifecycle stage dispatches no agent at all: the daemon runs
    // verify and reads the output itself. A skill that both wrote the tests and
    // reported the result would be the self-report the product refuses.
    expect(WRITE_TESTS_SKILL.situation).toBe('tier-unsatisfied');
    expect(WRITE_TESTS_SKILL.stage).toBeUndefined();
    expect(skillForStage('test')).toBeUndefined();
  });

  it('says it does not report a pass', () => {
    expect(`${WRITE_TESTS_SKILL.role} ${WRITE_TESTS_SKILL.stop_condition}`).toMatch(
      /do not (report|run)/i,
    );
  });

  it('refuses to advance the lifecycle, like every other skill', () => {
    expect(WRITE_TESTS_SKILL.role.toLowerCase()).toContain('do not advance');
  });
});

describe('every test must name the failure it would catch', () => {
  it('rejects a test with no `catches`', () => {
    // A test with no production change that would break it asserts something
    // already guaranteed, and passes forever without checking anything. Asked
    // for at the moment it is cheapest to answer.
    const schema = resolveOutputSchema('schemas/write-tests-output.schema.json');
    const missing = schema?.safeParse({
      work_item_id: 'X-1',
      tier: 'unit',
      tests: [{ file: 'a.test.ts', name: 'works' }],
    });
    expect(missing?.success).toBe(false);
  });

  it('rejects an empty `catches` rather than accepting the field being present', () => {
    const schema = resolveOutputSchema('schemas/write-tests-output.schema.json');
    const empty = schema?.safeParse({
      work_item_id: 'X-1',
      tier: 'unit',
      tests: [{ file: 'a.test.ts', name: 'works', catches: '' }],
    });
    expect(empty?.success).toBe(false);
  });
});

describe('registration', () => {
  it('is in CANONICAL_SKILLS, not merely exported', () => {
    expect(CANONICAL_SKILLS['write-tests']).toBe(WRITE_TESTS_SKILL);
  });
});
