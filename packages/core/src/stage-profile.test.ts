import { describe, expect, it } from 'vitest';
import { LIFECYCLE_STAGES } from './lifecycle.js';
import { CONTEXT_LAYER_KINDS, EFFORT_TIERS } from './context.js';
import {
  admitsChunk,
  applyRetrievalBudget,
  mandatoryLayers,
  matchesGlob,
  resolveStageProfile,
  STAGE_PROFILES,
  stagesWithoutProfile,
} from './stage-profile.js';

describe('per-stage profiles (P6-PERSTAGE-01, FEAT-CTX-003)', () => {
  it('covers every lifecycle stage', () => {
    // A stage with no profile falls back to "everything", which is the least
    // visible way to be wrong: the pack still assembles, the agent still
    // answers, and it answers with discovery notes in front of a one-line fix.
    expect(stagesWithoutProfile()).toEqual([]);
    expect(Object.keys(STAGE_PROFILES).sort()).toEqual([...LIFECYCLE_STAGES].sort());
  });

  it('gives every stage the two mandatory layers', () => {
    // The assembler refuses to truncate card-core — an agent handed a partial
    // task description confidently does the wrong thing. A profile that dropped
    // it would contradict the code that assembles it.
    for (const stage of LIFECYCLE_STAGES) {
      const profile = resolveStageProfile(stage);
      for (const layer of mandatoryLayers()) {
        expect(profile.layers, `${stage} is missing ${layer}`).toContain(layer);
      }
    }
  });

  it('names only real layer kinds', () => {
    // A profile asking for a layer the assembler does not build is a rule that
    // silently does nothing.
    for (const stage of LIFECYCLE_STAGES) {
      for (const layer of resolveStageProfile(stage).layers) {
        expect(CONTEXT_LAYER_KINDS, `${stage}: ${layer}`).toContain(layer);
      }
    }
  });

  it('says why each stage eats what it eats', () => {
    // The profile is a decision somebody made. One that cannot say why is a
    // preference that will be argued with and lost.
    for (const stage of LIFECYCLE_STAGES) {
      expect(resolveStageProfile(stage).because.length, stage).toBeGreaterThan(20);
    }
  });

  it('denies implement the research corpus', () => {
    // FEAT-CTX-002's own example: implementation does not need discovery notes,
    // and a pack carrying them spends the budget that should have gone to code.
    expect(resolveStageProfile('implement').docTypes).not.toContain('research');
    expect(resolveStageProfile('discovery').docTypes).toContain('research');
  });

  it('gives intake no retrieval at all', () => {
    // Nothing has been decided yet, so retrieval returns prior art and the agent
    // reads it as scope.
    expect(resolveStageProfile('intake').layers).not.toContain('retrieval');
    expect(resolveStageProfile('intake').docTypes).toEqual([]);
  });
});

describe('chunk admission (FEAT-CTX-002)', () => {
  const profile = resolveStageProfile('implement');

  it('admits an allowed type on an allowed path', () => {
    expect(admitsChunk(profile, { docType: 'spec', path: 'docs/specs/FEAT-001.md' })).toBe(true);
  });

  it('refuses a type this stage did not ask for', () => {
    expect(admitsChunk(profile, { docType: 'research', path: 'docs/research/a.md' })).toBe(false);
  });

  it('refuses an allowed type on an archived path', () => {
    // Both rules must pass. A `spec` under docs/archive/ is still archived, and a
    // rule that stopped at the type would return it as current.
    expect(admitsChunk(profile, { docType: 'spec', path: 'docs/archive/old.md' })).toBe(false);
  });

  it('refuses a chunk whose type is unknown', () => {
    // An allowlist fails closed. Failing open on "what may the agent read" is the
    // wrong direction for a mechanism whose job is keeping packs lean.
    expect(admitsChunk(profile, { path: 'docs/specs/a.md' })).toBe(false);
    expect(admitsChunk(profile, { docType: 'brand-new-type', path: 'x.md' })).toBe(false);
  });
});

describe('the glob subset', () => {
  it('matches `**` across directories and `*` within one', () => {
    expect(matchesGlob('docs/archive/**', 'docs/archive/2024/old.md')).toBe(true);
    expect(matchesGlob('**/_archive/**', 'kanban/epics/E-1/_archive/x.md')).toBe(true);
    expect(matchesGlob('docs/*.md', 'docs/README.md')).toBe(true);
  });

  it('does not let `*` cross a directory boundary', () => {
    // The distinction that makes the two wildcards worth having separately.
    expect(matchesGlob('docs/*.md', 'docs/specs/README.md')).toBe(false);
  });

  it('treats regex metacharacters in a pattern as literals', () => {
    // A path is user data. A `.` in a pattern matching any character would make
    // `docs/a.md` exclude `docs/aXmd`, which is a rule nobody wrote.
    expect(matchesGlob('docs/a.md', 'docs/aXmd')).toBe(false);
    expect(matchesGlob('docs/a.md', 'docs/a.md')).toBe(true);
  });
});

describe('per-stage budgets and effort tiers (P6-PERSTAGE-02, FEAT-CTX-015)', () => {
  it('gives every stage a budget and a tier', () => {
    for (const stage of LIFECYCLE_STAGES) {
      const profile = resolveStageProfile(stage);
      expect(profile.retrievalBudget, stage).toBeGreaterThanOrEqual(0);
      expect(EFFORT_TIERS, stage).toContain(profile.effortTier);
    }
  });

  it('gives a stage with no retrieval a budget of zero', () => {
    // A stage that may not retrieve and carries a budget of 4000 is two rules
    // disagreeing, and the one that wins is whichever code path reads first.
    for (const stage of LIFECYCLE_STAGES) {
      const profile = resolveStageProfile(stage);
      if (!profile.layers.includes('retrieval')) {
        expect(profile.retrievalBudget, stage).toBe(0);
      }
    }
  });

  it('gives a stage that may retrieve a budget above zero', () => {
    // The mirror of the rule above, and the one that catches a stage silently
    // retrieving nothing because a ceiling of 0 was left behind.
    for (const stage of LIFECYCLE_STAGES) {
      const profile = resolveStageProfile(stage);
      if (profile.layers.includes('retrieval')) {
        expect(profile.retrievalBudget, stage).toBeGreaterThan(0);
      }
    }
  });

  it('stops at the first chunk that does not fit', () => {
    // Not "skip it and try the next". A smaller, worse chunk squeezing past a
    // better one that just missed is how a budget quietly reorders the results,
    // and the ranking is what the retriever was for.
    const result = applyRetrievalBudget(
      [
        { tokens: 60, id: 'best' },
        { tokens: 50, id: 'big' },
        { tokens: 5, id: 'tiny' },
      ],
      100,
    );
    expect(result.admitted.map((c) => c.id)).toEqual(['best']);
    expect(result.dropped.map((c) => c.id)).toEqual(['big', 'tiny']);
    expect(result.tokensUsed).toBe(60);
  });

  it('reports what it dropped rather than discarding it', () => {
    // A pack silently missing its best chunk because of a ceiling is
    // indistinguishable from one where retrieval found nothing.
    const result = applyRetrievalBudget([{ tokens: 500, id: 'a' }], 100);
    expect(result.admitted).toEqual([]);
    expect(result.dropped.map((c) => c.id)).toEqual(['a']);
  });

  it('admits everything when it all fits', () => {
    const result = applyRetrievalBudget(
      [
        { tokens: 10, id: 'a' },
        { tokens: 10, id: 'b' },
      ],
      100,
    );
    expect(result.admitted).toHaveLength(2);
    expect(result.dropped).toEqual([]);
  });

  it('admits nothing at a budget of zero', () => {
    expect(applyRetrievalBudget([{ tokens: 1, id: 'a' }], 0).admitted).toEqual([]);
  });
});
