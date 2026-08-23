import { describe, expect, it } from 'vitest';
import { CANONICAL_SKILLS } from './canonical.js';
import {
  CaptureOutputSchema,
  ImportOutputSchema,
  NewProjectOutputSchema,
  outputJsonSchema,
  PrOutputSchema,
  ReleaseNotesOutputSchema,
  ResearchOutputSchema,
  resolveOutputSchema,
  SpecOutputSchema,
  TriageCaptureOutputSchema,
  UiExploreOutputSchema,
} from './output-schemas.js';

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

describe('the delivery output contracts (P6-PAYLOAD-04)', () => {
  it('makes an unsourced release note unwritable', () => {
    // The whole design of the schema. A plausible sentence about an improvement
    // reads exactly like a real one, which makes release notes the document most
    // likely to acquire a line nobody can trace.
    const result = ReleaseNotesOutputSchema.safeParse({
      range: 'v0.1.0..HEAD',
      entries: [{ summary: 'Faster startup.', breaking: false }],
    });
    expect(result.success).toBe(false);
  });

  it('refuses a breaking change with no migration note', () => {
    // The case the flag exists to prevent: a break the user finds out about by
    // upgrading. Marking it and saying nothing is worse than not marking it,
    // because the flag reads as though it was handled.
    const breaking = {
      range: 'v0.1.0..HEAD',
      entries: [{ work_item_id: 'FEAT-001', summary: 'Config moved.', breaking: true }],
    };
    expect(ReleaseNotesOutputSchema.safeParse(breaking).success).toBe(false);
    expect(
      ReleaseNotesOutputSchema.safeParse({
        ...breaking,
        entries: [
          { ...breaking.entries[0], migration: 'Move `sdlc.yaml` to `.sdlc/config.yaml`.' },
        ],
      }).success,
    ).toBe(true);
  });

  it('refuses a triage verdict that cannot be acted on', () => {
    // "promote" with no kind cannot be run, and "merge" with no target is a drop
    // wearing a kinder word.
    expect(
      TriageCaptureOutputSchema.safeParse({
        capture_id: 'CAP-001',
        verdict: 'promote',
        reason: 'real defect',
      }).success,
    ).toBe(false);
    expect(
      TriageCaptureOutputSchema.safeParse({
        capture_id: 'CAP-001',
        verdict: 'merge',
        reason: 'restates FEAT-004',
      }).success,
    ).toBe(false);
    expect(
      TriageCaptureOutputSchema.safeParse({
        capture_id: 'CAP-001',
        verdict: 'drop',
        reason: 'already fixed upstream',
      }).success,
    ).toBe(true);
  });

  it('gives a capture nowhere to record a classification', () => {
    // `sdlc capture` exists so noticing something does not require choosing a
    // kind. A `kind` field here would reintroduce that step through the output
    // contract, where the prompt could not stop it.
    expect(
      CaptureOutputSchema.safeParse({
        captures: [{ id: 'CAP-001', note: 'the retry backoff resets on 429', kind: 'bug' }],
      }).success,
    ).toBe(false);
  });

  it('gives the PR skill nowhere to characterise the evidence', () => {
    // `sdlc pr` renders test results and gate status from recorded runs. A field
    // for the model to describe them is an invitation to describe them, and its
    // account would be an opinion sitting beside a measurement.
    const valid = {
      work_item_id: 'FEAT-001',
      why: 'CSV export was the top support request.',
      approach: 'Stream rows rather than buffering the ledger.',
      not_in_scope: ['multi-currency'],
      review_focus: [{ path: 'src/export.ts', concern: 'the cursor is not closed on throw' }],
    };
    expect(PrOutputSchema.safeParse(valid).success).toBe(true);
    expect(PrOutputSchema.safeParse({ ...valid, tests_pass: true }).success).toBe(false);
    // And a review request with no specific worry is not a review request.
    expect(PrOutputSchema.safeParse({ ...valid, review_focus: [] }).success).toBe(false);
  });

  it('requires an import to say what it lost', () => {
    // An import that reports only its successes reads as complete, and the gap
    // surfaces weeks later as a document nobody can find.
    expect(
      ImportOutputSchema.safeParse({
        source: 'spec-kit',
        written: ['.sdlc/kanban/_imported/FEAT-001.md'],
        conflicts: [],
      }).success,
    ).toBe(false);
  });

  it('makes new-project record what it inferred rather than planning it', () => {
    const valid = {
      project_name: 'ledger',
      preset: 'standard',
      preset_rationale: 'money moves through it, but no external users yet',
      constitution_rules: ['every balance change is double-entry'],
      first_work_items: [
        { title: 'Import bank CSV', kind: 'feature', grounded_in: '"we get CSVs from the bank"' },
      ],
      open_questions: ['which banks?'],
    };
    expect(NewProjectOutputSchema.safeParse(valid).success).toBe(true);
    // A work item with no sentence behind it is a work item the model wrote.
    expect(
      NewProjectOutputSchema.safeParse({
        ...valid,
        first_work_items: [{ title: 'Add SSO', kind: 'feature' }],
      }).success,
    ).toBe(false);
    // A roadmap has nowhere to go, deliberately.
    expect(NewProjectOutputSchema.safeParse({ ...valid, roadmap: ['Q3: mobile'] }).success).toBe(
      false,
    );
  });
});

describe('the research contracts (P6-PAYLOAD-05)', () => {
  const paper = 'https://arxiv.org/abs/2401.00001';
  const seo = 'https://example.com/best-10-databases-2026';

  it('refuses a verified finding that rests only on tier C', () => {
    // ADR-0040 at the dispatch boundary: the agent proposes the finding and its
    // citations, and `assessSources` — the same classifier `sdlc research check`
    // uses — disposes of the claim that they substantiate it.
    const result = ResearchOutputSchema.safeParse({
      question: 'which driver?',
      subtype: 'db',
      findings: [{ claim: 'pg is fastest', confidence: 'verified', sources: [seo] }],
      open_questions: [],
    });
    expect(result.success).toBe(false);
  });

  it('accepts the same finding marked unverified', () => {
    // ADR-0073 says "unverified" is an allowed answer. A schema that only
    // accepted verified findings would make the honest report the one that fails
    // validation, and the model would learn to write the other one.
    expect(
      ResearchOutputSchema.safeParse({
        question: 'which driver?',
        subtype: 'db',
        findings: [{ claim: 'pg is fastest', confidence: 'unverified', sources: [seo] }],
        open_questions: ['no published benchmark with a method'],
      }).success,
    ).toBe(true);
  });

  it('accepts a verified finding backed by a primary source', () => {
    expect(
      ResearchOutputSchema.safeParse({
        question: 'which driver?',
        subtype: 'db',
        findings: [{ claim: 'pg supports pipelining', confidence: 'verified', sources: [paper] }],
        open_questions: [],
      }).success,
    ).toBe(true);
  });

  it('refuses a verified finding with no sources at all', () => {
    // "I recall it works this way" is the case the tiering exists for.
    expect(
      ResearchOutputSchema.safeParse({
        question: 'which driver?',
        subtype: 'db',
        findings: [{ claim: 'pg supports pipelining', confidence: 'verified', sources: [] }],
        open_questions: [],
      }).success,
    ).toBe(false);
  });

  it('refuses a subtype outside the vocabulary', () => {
    expect(
      ResearchOutputSchema.safeParse({
        question: 'x',
        subtype: 'vibes',
        findings: [],
        open_questions: [],
      }).success,
    ).toBe(false);
  });

  it('refuses a convention read off a single file', () => {
    // One example is an instance. A convention is what the codebase does when
    // nobody is looking, and a single-example one reported as existing is how a
    // third way of doing one thing gets built.
    const one = {
      work_item_id: 'FEAT-001',
      conventions: [
        { convention: 'buttons use the token scale', evidence: ['src/Button.tsx'], exceptions: [] },
      ],
      no_convention: [],
    };
    expect(UiExploreOutputSchema.safeParse(one).success).toBe(false);
    expect(
      UiExploreOutputSchema.safeParse({
        ...one,
        conventions: [
          {
            ...one.conventions[0],
            evidence: ['src/Button.tsx', 'src/Chip.tsx'],
          },
        ],
      }).success,
    ).toBe(true);
  });

  it('gives ui-explore nowhere to propose a redesign', () => {
    // It reports what exists. Deciding what the interface should do is the work
    // this runs *before*, and a redesign from the exploration pass is the
    // exploration pass having done the planning.
    expect(
      UiExploreOutputSchema.safeParse({
        work_item_id: 'FEAT-001',
        conventions: [],
        no_convention: ['empty states'],
        recommendation: 'adopt a design system',
      }).success,
    ).toBe(false);
  });
});
