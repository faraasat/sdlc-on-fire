import { z } from 'zod';
import type { CanonicalSkill } from '@sdlc-on-fire/core';
import { extractToolOutput, OutputContractError } from './dispatch.js';

/**
 * Skill regression fixtures (P0-EVAL-01, ADR-0042).
 *
 * ADR-0042's rule is blunt: a skill without fixtures is **not active**. Prompts
 * are code with no compiler — the only way an edit to a prompt is safe is if
 * something replays known inputs and checks the outputs still hold. A skill
 * nobody can regression-test is a skill nobody can safely change, and that is a
 * worse position than not having it.
 *
 * Fixtures assert on the **output contract**, not on prose. "The answer mentions
 * testing" is a rubric a model grades; "the emitted object parses and carries
 * these fields" is something a program decides (ADR-0040).
 */

export const FixtureAssertionSchema = z.object({
  /** Dotted path into the emitted object, e.g. `acceptance_criteria.0`. */
  path: z.string().min(1),
  /** Exact value, when the field is deterministic. */
  equals: z.unknown().optional(),
  /** Substring the stringified value must contain. */
  contains: z.string().optional(),
  /** The field must be present and non-empty. */
  present: z.boolean().optional(),
});

export const SkillFixtureSchema = z.object({
  name: z.string().min(1),
  /** Slot values the skill is rendered with. */
  variables: z.record(z.string(), z.string()).default({}),
  /** Recorded target output — the stdout a run produced, replayed here. */
  recordedOutput: z.string().min(1),
  /** Which compile target produced it; assertions can differ per target. */
  target: z.string().min(1).default('claude-code'),
  assertions: z.array(FixtureAssertionSchema).min(1),
  /** When set, the fixture asserts the output is *rejected* for this reason. */
  expectsRejection: z.string().optional(),
});

export type SkillFixture = z.infer<typeof SkillFixtureSchema>;

export interface FixtureFailure {
  readonly fixture: string;
  readonly reason: string;
}

export interface FixtureRunResult {
  readonly skill: string;
  readonly ran: number;
  readonly failures: readonly FixtureFailure[];
  readonly ok: boolean;
}

function valueAt(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((current, segment) => {
    if (current === null || typeof current !== 'object') return undefined;
    return (current as Record<string, unknown>)[segment];
  }, value);
}

function checkAssertion(
  output: Record<string, unknown>,
  assertion: z.infer<typeof FixtureAssertionSchema>,
): string | null {
  const actual = valueAt(output, assertion.path);

  if (assertion.present === true) {
    const empty =
      actual === undefined ||
      actual === null ||
      (typeof actual === 'string' && actual.trim() === '') ||
      (Array.isArray(actual) && actual.length === 0);
    if (empty) return `"${assertion.path}" is absent or empty`;
  }
  if (
    assertion.equals !== undefined &&
    JSON.stringify(actual) !== JSON.stringify(assertion.equals)
  ) {
    return `"${assertion.path}" is ${JSON.stringify(actual)}, expected ${JSON.stringify(assertion.equals)}`;
  }
  if (
    assertion.contains !== undefined &&
    !JSON.stringify(actual ?? '').includes(assertion.contains)
  ) {
    return `"${assertion.path}" does not contain "${assertion.contains}"`;
  }
  return null;
}

/**
 * Replays a skill's fixtures against the real extraction path.
 *
 * Deliberately reuses `extractToolOutput` rather than parsing the recorded
 * output itself: a harness that checked a different code path from production
 * would pass while production failed, which is the same defect `runDoctor`
 * avoids by compiling for real.
 */
export function runFixtures(
  skill: CanonicalSkill,
  fixtures: readonly SkillFixture[],
): FixtureRunResult {
  const failures: FixtureFailure[] = [];

  for (const fixture of fixtures) {
    let output: Record<string, unknown>;
    try {
      output = extractToolOutput(fixture.recordedOutput, skill);
    } catch (cause) {
      // A fixture may exist precisely to pin a rejection — an agent claiming
      // its own tests passed must keep being refused, and that is a behaviour
      // worth regression-testing.
      if (fixture.expectsRejection !== undefined) {
        const message = cause instanceof Error ? cause.message : String(cause);
        if (!message.includes(fixture.expectsRejection)) {
          failures.push({
            fixture: fixture.name,
            reason: `expected rejection containing "${fixture.expectsRejection}", got: ${message}`,
          });
        }
        continue;
      }
      failures.push({
        fixture: fixture.name,
        reason: `output was rejected: ${cause instanceof OutputContractError ? cause.message : String(cause)}`,
      });
      continue;
    }

    if (fixture.expectsRejection !== undefined) {
      failures.push({
        fixture: fixture.name,
        reason: `expected the output to be rejected (${fixture.expectsRejection}), but it was accepted`,
      });
      continue;
    }

    for (const assertion of fixture.assertions) {
      const problem = checkAssertion(output, assertion);
      if (problem !== null) failures.push({ fixture: fixture.name, reason: problem });
    }
  }

  return { skill: skill.name, ran: fixtures.length, failures, ok: failures.length === 0 };
}

/**
 * The activation rule: no fixtures, not active (ADR-0042).
 *
 * Returned as a finding rather than enforced by throwing, so `agents doctor`
 * can report every unfixtured skill at once instead of stopping at the first.
 */
export function unfixturedSkills(
  skills: readonly CanonicalSkill[],
  fixtures: ReadonlyMap<string, readonly SkillFixture[]>,
): readonly string[] {
  return skills
    .filter((skill) => (fixtures.get(skill.name)?.length ?? 0) === 0)
    .map((skill) => skill.name);
}
