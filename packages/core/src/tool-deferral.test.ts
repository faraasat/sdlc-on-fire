import { describe, expect, it } from 'vitest';
import { deferralPlan, HOT_SKILLS, HOT_TOOL_LIMIT } from './tool-deferral.js';
import type { CanonicalSkill } from './skill.js';

const skill = (over: Partial<CanonicalSkill> & { name: string }): CanonicalSkill =>
  ({ tier: 'medium', ...over }) as CanonicalSkill;

describe('deferral plan (P2-AGT-02)', () => {
  it('keeps the declared skills hot and defers the long tail', () => {
    const plan = deferralPlan([
      skill({ name: 'implement', stage: 'implement' }),
      skill({ name: 'security-review', situation: 'high-risk-surface' }),
      skill({ name: 'release-notes', user_invoked: true }),
    ]);
    expect(plan.hot.map((d) => d.name)).toEqual(['implement']);
    expect(plan.deferred.map((d) => d.name).sort()).toEqual(['release-notes', 'security-review']);
  });

  it('declares no more hot skills than the cap allows', () => {
    expect(Object.keys(HOT_SKILLS).length).toBeLessThanOrEqual(HOT_TOOL_LIMIT);
  });

  it('gives every declared hot skill a reason', () => {
    // The list is a decision, not a derivation — two derivations were tried and
    // both were deterministic and wrong. A reason is what makes it arguable.
    for (const [name, because] of Object.entries(HOT_SKILLS)) {
      expect(because.length, name).toBeGreaterThan(20);
    }
  });

  it('never declares a skill that runs once per card', () => {
    // Alphabetical order kept `retrospective`, which runs when a card ships.
    expect(Object.keys(HOT_SKILLS)).not.toContain('retrospective');
  });

  it('never defers everything', () => {
    // The API rejects a request where every tool is deferred, outright. The
    // caller writing the config is the one who hits that 400.
    const plan = deferralPlan([skill({ name: 'capture', user_invoked: true })]);
    expect(plan.because).toMatch(/at least one tool must stay non-deferred/);
    expect(plan.hot).toEqual([]);
  });

  it('breaks ties on name, not registry order', () => {
    // `Object.values` order is stable but incidental. A hot set that changed
    // because somebody reordered a record would silently move a tool in and out
    // of context between builds.
    const forward = deferralPlan([
      skill({ name: 'aaa', stage: 'spec' }),
      skill({ name: 'zzz', stage: 'review' }),
    ]);
    const reversed = deferralPlan([
      skill({ name: 'zzz', stage: 'review' }),
      skill({ name: 'aaa', stage: 'spec' }),
    ]);
    expect(forward.hot.map((d) => d.name)).toEqual(reversed.hot.map((d) => d.name));
  });

  it('gives every decision a reason', () => {
    const plan = deferralPlan([
      skill({ name: 'implement', stage: 'implement' }),
      skill({ name: 'pr', user_invoked: true }),
    ]);
    for (const decision of [...plan.hot, ...plan.deferred]) {
      expect(decision.because.length, decision.name).toBeGreaterThan(15);
    }
  });
});
