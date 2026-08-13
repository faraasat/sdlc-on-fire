import { describe, expect, it } from 'vitest';
import type { EvidenceEnvelope } from '@sdlc-on-fire/core';
import {
  blockingKinds,
  formatTaxonomyPolicy,
  isMetamorphic,
  metamorphicRequirement,
  taxonomyPolicy,
} from './taxonomy-policy.js';

/**
 * P2-QA-05 — promoting the test taxonomy to blocking gate inputs.
 *
 * Two claims under test: which kinds block at which preset, and that the
 * alternate-path requirement is checked from envelope metadata rather than
 * inferred from a naming convention.
 */

const envelope = (over: Partial<EvidenceEnvelope> = {}): EvidenceEnvelope =>
  ({
    kind: 'test',
    git_sha: 'a'.repeat(40),
    content_hash: 'b'.repeat(64),
    confidence: 1,
    produced_at: '2026-08-12T00:00:00.000Z',
    payload: {},
    ...over,
  }) as EvidenceEnvelope;

describe('taxonomyPolicy', () => {
  it('leaves lite exactly as v0.1 had it', () => {
    // A team on `lite` chose cheap. Quietly making cheap expensive is how a
    // preset stops meaning anything.
    expect(blockingKinds('lite')).toEqual(['test', 'typecheck', 'build']);
  });

  it('promotes lint and security scanning at standard', () => {
    expect(blockingKinds('standard')).toContain('security-scan');
    expect(blockingKinds('standard')).toContain('lint');
  });

  it('adds e2e and coverage at strict', () => {
    expect(blockingKinds('strict')).toContain('e2e');
    expect(blockingKinds('strict')).toContain('coverage-delta');
  });

  it('never drops a kind a lower preset required', () => {
    // A stricter preset asking for *less* would be a bug nobody notices until
    // a strict project ships something a lite one would have caught.
    for (const kind of blockingKinds('lite')) {
      expect(blockingKinds('standard')).toContain(kind);
      expect(blockingKinds('strict')).toContain(kind);
    }
    for (const kind of blockingKinds('standard')) {
      expect(blockingKinds('strict')).toContain(kind);
    }
  });

  it('requires freshness for the scans most damaged by staleness', () => {
    const policy = taxonomyPolicy('strict');
    const scan = policy.evidence.find((requirement) => requirement.kind === 'security-scan');
    // The commit that introduced the vulnerability is exactly the commit an old
    // scan did not see.
    expect(scan?.require_fresh).toBe(true);
    const build = policy.evidence.find((requirement) => requirement.kind === 'build');
    expect(build?.require_fresh).toBe(false);
  });

  it('marks every listed kind required', () => {
    expect(taxonomyPolicy('standard').evidence.every((r) => r.required)).toBe(true);
  });

  it('falls back to lite for an unknown preset', () => {
    // Falling back to `strict` would block a project that never asked for it;
    // falling back to nothing would gate on nothing at all.
    expect(blockingKinds('not-a-preset')).toEqual(blockingKinds('lite'));
  });
});

describe('isMetamorphic', () => {
  it('reads the envelope metadata', () => {
    expect(isMetamorphic(envelope({ payload: { metamorphic: true } }))).toBe(true);
    expect(isMetamorphic(envelope({ payload: { metamorphic: false } }))).toBe(false);
    expect(isMetamorphic(envelope({ payload: {} }))).toBe(false);
  });

  it('does not guess from anything else', () => {
    // A title convention drifts, gets translated, and fails silently the first
    // time somebody renames a describe block.
    expect(isMetamorphic(envelope({ payload: { title: 'metamorphic: two routes agree' } }))).toBe(
      false,
    );
  });

  it('survives a null or absent payload', () => {
    expect(isMetamorphic(envelope({ payload: null }))).toBe(false);
    expect(isMetamorphic(envelope({ payload: undefined }))).toBe(false);
  });

  it('does not accept a truthy non-true value', () => {
    // `metamorphic: "yes"` is a mistake, and treating it as a pass would let a
    // typo satisfy the requirement.
    expect(isMetamorphic(envelope({ payload: { metamorphic: 'yes' } }))).toBe(false);
    expect(isMetamorphic(envelope({ payload: { metamorphic: 1 } }))).toBe(false);
  });
});

describe('metamorphicRequirement', () => {
  const metamorphic = envelope({ payload: { metamorphic: true } });
  const ordinary = envelope();

  it('is satisfied by a single alternate-path case', () => {
    // ADR-0044 asks for at least one, not a proportion: a quota produces nine
    // contrived cases and one real one.
    const requirement = metamorphicRequirement('standard', [ordinary, metamorphic]);
    expect(requirement.satisfied).toBe(true);
    expect(requirement.count).toBe(1);
  });

  it('is unsatisfied at standard with none', () => {
    const requirement = metamorphicRequirement('standard', [ordinary, ordinary]);
    expect(requirement.satisfied).toBe(false);
    expect(requirement.reason).toContain('cannot see that route breaking');
  });

  it('is not required at lite', () => {
    const requirement = metamorphicRequirement('lite', []);
    expect(requirement.required).toBe(false);
    expect(requirement.satisfied).toBe(true);
  });

  it('counts only test envelopes', () => {
    // A security scan tagged metamorphic is a mislabelled scan, not an
    // alternate-path test.
    const mislabelled = envelope({ kind: 'security-scan', payload: { metamorphic: true } });
    expect(metamorphicRequirement('standard', [mislabelled]).satisfied).toBe(false);
  });

  it('still counts alternate-path cases where they are not required', () => {
    // Reporting the count regardless means a team can see they already meet a
    // stricter preset's bar before switching to it.
    expect(metamorphicRequirement('lite', [metamorphic]).count).toBe(1);
  });
});

describe('formatTaxonomyPolicy', () => {
  it('lists what the preset blocks on', () => {
    const text = formatTaxonomyPolicy('standard', metamorphicRequirement('standard', []));
    expect(text).toContain('security-scan');
    expect(text).toContain('✗ alternate-path');
  });
});
