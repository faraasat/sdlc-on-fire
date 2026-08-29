import { describe, expect, it } from 'vitest';
import { consultsSituations, STAGES_CONSULTING_SITUATIONS } from './situations.js';

/**
 * Which skill-less stages fall through to the diff (P6-SURFACE-15).
 *
 * `situationsFromDiff` itself is exercised from `ui-surface.test.ts`, where the
 * detector it wraps lives. This file is about the table that decides *when* it
 * is consulted, which is a separate decision and deserves a separate home.
 */

describe('stages that consult the situations (P6-SURFACE-15)', () => {
  it('lets security_review fall through to the diff', () => {
    // The strict ladder routes cards through `security_review` and nothing
    // dispatched there: the security-review skill is situational, not
    // stage-bound. Binding it would give up the situational dispatch it was
    // built for, because a skill declares exactly one trigger.
    expect(consultsSituations('security_review')).toBe(true);
  });

  it('does NOT let test fall through', () => {
    // `test` has no skill deliberately — the daemon runs verify and reads the
    // output itself. A fall-through would dispatch `write-tests` on
    // `tier-unsatisfied` and quietly contradict the sentence that explains why
    // the stage is empty.
    expect(consultsSituations('test')).toBe(false);
  });

  it('does not turn every skill-less stage into a fall-through', () => {
    // An explicit table, not a universal rule. The stages absent from it are
    // decisions too.
    for (const stage of ['intake', 'approval', 'done', 'implement']) {
      expect(consultsSituations(stage), stage).toBe(false);
    }
  });

  it('says why, for every stage that consults', () => {
    // A table entry with no reason is a preference that will be argued with and
    // lost.
    for (const [stage, because] of Object.entries(STAGES_CONSULTING_SITUATIONS)) {
      expect(because.length, stage).toBeGreaterThan(20);
    }
  });
});
