import { RESEARCH_FOCUS, RESEARCH_SUBTYPES } from '@sdlc-on-fire/core';
import { describe, expect, it } from 'vitest';
import { RESEARCH_SKILL, UI_EXPLORE_SKILL } from './research.js';

describe('the research skills (P6-PAYLOAD-05)', () => {
  it('covers every subtype from one skill', () => {
    // The P6-PAYLOAD-02 lesson applied a second time: N skills against an
    // M-value vocabulary drifts, and it drifts silently — the missing ones look
    // exactly like a finished feature. An eighth subtype (tech-debt is already
    // proposed) cannot leave a skill behind, because there is one.
    for (const subtype of RESEARCH_SUBTYPES) {
      expect(RESEARCH_SKILL.task, subtype).toContain(subtype);
      expect(RESEARCH_SKILL.task, subtype).toContain(RESEARCH_FOCUS[subtype]);
    }
  });

  it('names every subtype in the argument description', () => {
    // The MCP target compiles this straight into `inputSchema`, where it is the
    // whole of what the model is told about the argument.
    const subtype = RESEARCH_SKILL.arguments?.find((a) => a.name === 'subtype');
    for (const value of RESEARCH_SUBTYPES) {
      expect(subtype?.description, value).toContain(value);
    }
  });

  it('asks the researcher to check its own citations resolve', () => {
    // A citation that does not resolve, or resolves to something else, is the
    // form of evidence without the substance — and it is read as the substance.
    expect(RESEARCH_SKILL.self_verification?.toLowerCase()).toContain('resolve');
  });

  it('runs ui-explore on a detected situation, not a declared one', () => {
    // `touches-ui` is computed by `situationsFromDiff`. A value in a closed enum
    // that nothing produces reads in review exactly like a dispatch path that
    // works, which is the defect closing the enum was meant to prevent.
    expect(UI_EXPLORE_SKILL.situation).toBe('touches-ui');
    expect(UI_EXPLORE_SKILL.stage).toBeUndefined();
  });

  it('keeps both research skills out of the write path', () => {
    for (const skill of [RESEARCH_SKILL, UI_EXPLORE_SKILL]) {
      expect(skill.stop_condition.toLowerCase(), skill.name).toContain('do not');
      expect(skill.context_mode, skill.name).toBe('fork');
    }
  });
});
