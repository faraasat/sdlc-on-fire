import { describe, expect, it } from 'vitest';
import { CANONICAL_SKILLS } from './canonical.js';
import { outputJsonSchema, resolveOutputSchema, SpecOutputSchema } from './output-schemas.js';

/**
 * The output contract, made real.
 *
 * Every skill declared a `json_schema_ref` and the prompt told the agent its
 * arguments "must validate against" it. The referenced files did not exist
 * anywhere in the product and nothing validated anything — a blind evaluation
 * went looking for `schemas/spec-output.schema.json` and found the entire
 * contract was a sentence in a prompt.
 */

describe('every declared reference resolves', () => {
  it('has a schema for each canonical skill, so no ref points at nothing', () => {
    // Structural, not exemplary: a new skill with a dangling ref fails here
    // rather than at dispatch, when a model has already been paid.
    for (const skill of Object.values(CANONICAL_SKILLS)) {
      const ref = skill.output_contract.json_schema_ref;
      expect(resolveOutputSchema(ref), `${skill.name} → ${ref}`).toBeDefined();
    }
  });

  it('renders as JSON Schema, so the prompt and the check cannot drift', () => {
    // Generated from the Zod schema rather than maintained beside it: two
    // hand-written descriptions of one contract disagree eventually, and the
    // copy in the prompt is the one nobody re-reads.
    const rendered = outputJsonSchema('schemas/spec-output.schema.json') as {
      required?: string[];
    };
    expect(rendered.required).toContain('acceptance_criteria');
    expect(rendered.required).toContain('non_goals');
  });
});

describe('the spec contract enforces what the skill asks for', () => {
  const valid = {
    work_item_id: 'FEAT-001',
    summary: 'Export invoices as CSV.',
    acceptance_criteria: ['GIVEN a ledger WHEN exported THEN each row is one invoice'],
    non_goals: ['multi-currency'],
    handoff: { openQuestions: [] },
  };

  it('accepts a spec that meets its own stated bar', () => {
    expect(SpecOutputSchema.safeParse(valid).success).toBe(true);
  });

  it('refuses a criterion that is not GIVEN/WHEN/THEN', () => {
    // The skill instruction says every criterion MUST be in that form. An
    // instruction the contract does not check is a suggestion.
    const result = SpecOutputSchema.safeParse({
      ...valid,
      acceptance_criteria: ['it should work'],
    });
    expect(result.success).toBe(false);
  });

  it('refuses an empty non_goals list', () => {
    // Scope creep is rarely a decision anyone makes; it is the absence of one,
    // and an empty non-goals list is what that absence looks like (P1-OBJ-06).
    expect(SpecOutputSchema.safeParse({ ...valid, non_goals: [] }).success).toBe(false);
  });

  it('refuses an unknown key rather than carrying it into a run record', () => {
    expect(SpecOutputSchema.safeParse({ ...valid, verified: true }).success).toBe(false);
  });
});
