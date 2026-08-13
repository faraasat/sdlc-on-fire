import { describe, expect, it } from 'vitest';
import {
  CONFIDENCE_SOURCES,
  CONFIDENCE_THRESHOLDS,
  formatRouting,
  logprobConfidence,
  maySampleFor,
  ROUTE_SEVERITY,
  routeOnConfidence,
  rubricConfidence,
  samplingCost,
  selfConsistency,
} from './confidence.js';

/**
 * P2-GATE-05 — confidence-gated routing.
 *
 * The load-bearing property is negative: no path through this module lets a
 * model's account of itself become a routing decision, and no confidence number
 * however high can lower the rigor a preset already committed to.
 */

describe('the signal sources are closed', () => {
  it('admits only harness-derived sources', () => {
    // ADR-0025: never "ask the model to rate itself". Enforced by the type
    // having no such member rather than by a rule somebody remembers — the same
    // device as `actorKind: 'human'` on approvals.
    expect([...CONFIDENCE_SOURCES]).toEqual(['self-consistency', 'logprob', 'rubric']);
    expect(CONFIDENCE_SOURCES).not.toContain('narrated');
    expect(CONFIDENCE_SOURCES).not.toContain('self-rated');
  });
});

describe('selfConsistency', () => {
  it('is 1 when every sample agrees', () => {
    expect(selfConsistency(['yes', 'yes', 'yes'])?.value).toBe(1);
  });

  it('falls as the answers spread', () => {
    expect(selfConsistency(['a', 'a', 'b'])?.value).toBeCloseTo(2 / 3);
    expect(selfConsistency(['a', 'b', 'c', 'd', 'e'])?.value).toBeCloseTo(0.2);
  });

  it('ignores case and surrounding whitespace', () => {
    expect(selfConsistency([' Yes ', 'yes'])?.value).toBe(1);
  });

  it('refuses a single sample rather than reporting certainty', () => {
    // One sample is 1.0 by arithmetic and carries no information. A confidence
    // of 1.0 derived from asking once is the most misleading number this
    // function could return.
    expect(selfConsistency(['yes'])).toBeNull();
    expect(selfConsistency([])).toBeNull();
  });

  it('records how many calls produced it', () => {
    expect(selfConsistency(['a', 'a', 'b'])?.samples).toBe(3);
  });
});

describe('logprobConfidence', () => {
  it('converts mean log-probability into a 0–1 value', () => {
    expect(logprobConfidence([Math.log(0.9), Math.log(0.9)])?.value).toBeCloseTo(0.9);
  });

  it('does not punish a long answer for being long', () => {
    // Sequence probability shrinks with length; the mean does not. Otherwise
    // every long output would look uncertain regardless of quality.
    const short = logprobConfidence([Math.log(0.9)])?.value;
    const long = logprobConfidence(Array.from({ length: 200 }, () => Math.log(0.9)))?.value;
    expect(long).toBeCloseTo(short!);
  });

  it('costs one call', () => {
    expect(logprobConfidence([Math.log(0.9)])?.samples).toBe(1);
  });

  it('returns nothing when the provider reported nothing', () => {
    expect(logprobConfidence([])).toBeNull();
  });
});

describe('rubricConfidence', () => {
  it('is the pass ratio', () => {
    expect(rubricConfidence(3, 4)?.value).toBe(0.75);
  });

  it('returns nothing for an empty rubric', () => {
    // Zero criteria passing zero criteria is not confidence, it is a rubric
    // that did not run.
    expect(rubricConfidence(0, 0)).toBeNull();
  });
});

describe('routeOnConfidence — the routes', () => {
  it('proceeds on a strong signal', () => {
    const decision = routeOnConfidence({ source: 'logprob', value: 0.9, samples: 1 }, 'standard');
    expect(decision.route).toBe('proceed');
  });

  it('retries with more context in the middle band', () => {
    expect(routeOnConfidence({ source: 'logprob', value: 0.6, samples: 1 }, 'standard').route).toBe(
      'retry-with-context',
    );
  });

  it('escalates a tier when more context is unlikely to help', () => {
    expect(routeOnConfidence({ source: 'logprob', value: 0.3, samples: 1 }, 'standard').route).toBe(
      'escalate-tier',
    );
  });

  it('defers to a human at the bottom', () => {
    expect(
      routeOnConfidence({ source: 'logprob', value: 0.05, samples: 1 }, 'standard').route,
    ).toBe('defer-to-human');
  });

  it('names the source and the sample count in the reason', () => {
    const decision = routeOnConfidence(
      { source: 'self-consistency', value: 0.66, samples: 3 },
      'standard',
    );
    expect(decision.reason).toContain('self-consistency');
    expect(decision.reason).toContain('3 sample');
  });
});

describe('routeOnConfidence — absence is not confidence', () => {
  for (const preset of ['lite', 'standard', 'strict'] as const) {
    it(`defers to a human when nothing was measured (${preset})`, () => {
      // A provider with no log-probabilities, a budget that refused sampling, a
      // rubric that could not run — all mean nothing was measured. Reading that
      // as "it is fine" is the substitution this product refuses everywhere
      // else, and it is the failure that would be invisible: an unmeasured task
      // proceeding looks exactly like a confident one.
      const decision = routeOnConfidence(null, preset);
      expect(decision.route).toBe('defer-to-human');
      expect(decision.reason).toContain('not the same as');
    });
  }
});

describe('routeOnConfidence — confidence is additive, never subtractive', () => {
  it('has no route that removes work', () => {
    // ADR-0025: additive on top of, not a replacement for, the static preset.
    // The guarantee is structural rather than arithmetic — there is no value
    // `routeOnConfidence` can return that shortens a preset's ladder. `proceed`
    // means "continue with the stages already required", and the other three
    // only add.
    //
    // An earlier version of this file enforced that with a per-preset floor
    // table whose every entry was the *lowest* route, so the clamp could never
    // fire. This test asserts the property that actually holds.
    expect(Math.min(...Object.values(ROUTE_SEVERITY))).toBe(0);
    expect(ROUTE_SEVERITY.proceed).toBe(0);
    expect(Object.keys(ROUTE_SEVERITY)).not.toContain('skip');
    expect(Object.keys(ROUTE_SEVERITY)).not.toContain('downgrade');
  });

  it('gives the same route for the same signal at any preset', () => {
    // The preset sets the baseline rigor; the signal decides what to *add*.
    // Letting the preset change the reading would make the same measurement
    // mean two things.
    const signal = { source: 'rubric', value: 0.5, samples: 1 } as const;
    const routes = (['lite', 'standard', 'strict'] as const).map(
      (preset) => routeOnConfidence(signal, preset).route,
    );
    expect(new Set(routes).size).toBe(1);
  });

  it('a perfect score never turns a deferral into a proceed', () => {
    const measured = routeOnConfidence({ source: 'rubric', value: 1, samples: 1 }, 'strict');
    const unmeasured = routeOnConfidence(null, 'strict');
    expect(measured.route).toBe('proceed');
    expect(unmeasured.route).toBe('defer-to-human');
  });

  it('keeps its thresholds nameable rather than inlined', () => {
    // Starting values, not measurements: no calibration data exists yet for how
    // well any of these predicts a failing gate on this product's own tasks.
    expect(CONFIDENCE_THRESHOLDS.proceed).toBe(0.75);
    expect(CONFIDENCE_THRESHOLDS.defer).toBe(0.2);
  });
});

describe('the cost of the signal is visible before it is paid', () => {
  it('reports sampling cost as extra calls', () => {
    expect(samplingCost(1)).toBe(0);
    expect(samplingCost(3)).toBe(2);
  });

  it('refuses sampling entirely at lite', () => {
    // A team on `lite` asked for cheap. N× inference to decide whether to
    // escalate costs more than the escalation it is deciding about.
    expect(maySampleFor('lite')).toBe(1);
    expect(samplingCost(maySampleFor('lite'))).toBe(0);
  });

  it('allows more sampling as the preset gets stricter', () => {
    expect(maySampleFor('standard')).toBeGreaterThan(maySampleFor('lite'));
    expect(maySampleFor('strict')).toBeGreaterThanOrEqual(maySampleFor('standard'));
  });
});

describe('formatRouting', () => {
  it('shows what the signal cost when it cost anything', () => {
    const text = formatRouting(
      routeOnConfidence({ source: 'self-consistency', value: 0.9, samples: 3 }, 'strict'),
      'strict',
    );
    expect(text).toContain('2 extra model call');
  });

  it('does not mention cost for a single-call signal', () => {
    const text = formatRouting(
      routeOnConfidence({ source: 'logprob', value: 0.9, samples: 1 }, 'standard'),
      'standard',
    );
    expect(text).not.toContain('extra model call');
  });

  it('says plainly that a deferral stops automation', () => {
    expect(formatRouting(routeOnConfidence(null, 'standard'), 'standard')).toContain(
      'nothing automated continues',
    );
  });
});
