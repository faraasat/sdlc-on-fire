import { describe, expect, it } from 'vitest';
import { needsDiversity, NoDiverseModelError, pickDiverseModel } from './model-diversity.js';

describe('enforced adversarial diversity (P6-SURFACE-09)', () => {
  it('takes the primary when it has not worked on this item', () => {
    // Diversity only gets to skip. It never reorders — the candidate list is the
    // tier's preference order, and re-scoring it to "maximise diversity" would
    // silently downgrade the model doing the review.
    const choice = pickDiverseModel(['opus', 'sonnet'], ['haiku'], 'high');
    expect(choice.model).toBe('opus');
    expect(choice.avoided).toBe(false);
  });

  it('skips a model that already worked on the item', () => {
    // A model reviewing its own output is the same model asked twice, agreeing
    // with itself for the reasons it was wrong the first time.
    const choice = pickDiverseModel(['opus', 'sonnet'], ['opus'], 'high');
    expect(choice.model).toBe('sonnet');
    expect(choice.avoided).toBe(true);
  });

  it('refuses rather than falling back to the excluded model', () => {
    // A review that announces itself as adversarial and is not is worse than an
    // absent one, because the gate records that a review happened.
    expect(() => pickDiverseModel(['opus'], ['opus'], 'high')).toThrow(NoDiverseModelError);
  });

  it('says what to do about it in the refusal', () => {
    expect(() => pickDiverseModel(['opus'], ['opus'], 'high')).toThrow(/configure a fallback/);
  });

  it('is unaffected by a run row that recorded no model', () => {
    // A NULL model reads back as '', which cannot match any candidate —
    // `PinnedModelSchema` requires a non-empty, version-pinned id. Asserted
    // because the property is what makes filtering unnecessary, not because a
    // filter exists: one did, and mutation testing showed nothing depended on
    // it.
    expect(pickDiverseModel(['opus'], ['', ''], 'high').model).toBe('opus');
    // And a real model beside the empty one still excludes normally.
    expect(() => pickDiverseModel(['opus'], ['opus', ''], 'high')).toThrow();
  });

  it('applies to review and security_review, and not to test', () => {
    // `test` dispatches no agent at all — the daemon runs verify and reads the
    // output itself, so there is no second opinion to keep independent.
    expect(needsDiversity('review')).toBe(true);
    expect(needsDiversity('security_review')).toBe(true);
    expect(needsDiversity('test')).toBe(false);
    expect(needsDiversity('implement')).toBe(false);
  });
});
