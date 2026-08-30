import { describe, expect, it } from 'vitest';
import {
  classifyConfigDrift,
  isDowngrade,
  PRESET_STRENGTH,
  type GateStrengthConfig,
} from './config-drift.js';

/**
 * The abandonment leading indicator (P8-BAR-03, metrics.md §3a, R-08).
 *
 * Each test names the wrong answer it exists to prevent, because every one of
 * these has a plausible implementation that reports the opposite of the truth.
 */

const base: GateStrengthConfig = {
  preset: 'standard',
  mode: 'solo',
  sandboxTier: 'none',
  sandboxRequired: false,
  autoApproveUnambiguous: false,
};

const with_ = (patch: Partial<GateStrengthConfig>): GateStrengthConfig => ({ ...base, ...patch });

describe('classifyConfigDrift', () => {
  it('reports nothing when nothing moved', () => {
    const drift = classifyConfigDrift(base, { ...base });
    expect(drift.direction).toBe('unchanged');
    expect(drift.changes).toEqual([]);
  });

  it('calls standard → lite a downgrade', () => {
    const drift = classifyConfigDrift(base, with_({ preset: 'lite' }));
    expect(drift.direction).toBe('weakened');
    expect(isDowngrade(drift)).toBe(true);
  });

  it('calls standard → strict a strengthening, not merely a change', () => {
    const drift = classifyConfigDrift(base, with_({ preset: 'strict' }));
    expect(drift.direction).toBe('strengthened');
    expect(isDowngrade(drift)).toBe(false);
  });

  it('treats team → solo as a downgrade despite neither word sounding like one', () => {
    // solo auto-satisfies an approval rule nobody but the author could meet.
    // The board that deadlocked yesterday advances today, and a naive
    // implementation reads this as an unranked enum change worth nothing.
    const drift = classifyConfigDrift(with_({ mode: 'team' }), with_({ mode: 'solo' }));
    expect(drift.direction).toBe('weakened');
    expect(drift.changes[0]?.field).toBe('mode');
  });

  it('treats solo → team as a strengthening', () => {
    const drift = classifyConfigDrift(base, with_({ mode: 'team' }));
    expect(drift.direction).toBe('strengthened');
  });

  it('reads sandbox.required going false as a control becoming a suggestion', () => {
    const drift = classifyConfigDrift(with_({ sandboxRequired: true }), base);
    expect(drift.direction).toBe('weakened');
    expect(drift.changes[0]?.because).toContain('suggestion');
  });

  it('reads autoApproveUnambiguous going true as a weakening', () => {
    // The polarity is the trap: `true` on a field whose name sounds helpful is
    // the weaker setting, because it removes a human checkpoint.
    const drift = classifyConfigDrift(base, with_({ autoApproveUnambiguous: true }));
    expect(drift.direction).toBe('weakened');
  });

  it('ranks a sandbox tier dropping to none as weaker', () => {
    const drift = classifyConfigDrift(with_({ sandboxTier: 'seatbelt' }), base);
    expect(drift.direction).toBe('weakened');
  });

  it('does not let a strengthening cancel a downgrade', () => {
    // A config that tightened the sandbox and dropped to `lite` has still
    // dropped to `lite`. Netting them out is how a leading indicator stops
    // leading, so the direction is `mixed` and `isDowngrade` still fires.
    const drift = classifyConfigDrift(
      base,
      with_({ preset: 'lite', sandboxTier: 'seatbelt', sandboxRequired: true }),
    );
    expect(drift.direction).toBe('mixed');
    expect(isDowngrade(drift)).toBe(true);
  });

  it('ignores an unrecognised preset rather than calling it the weakest', () => {
    // A typo in the config would otherwise rank -1 and fire the abandonment
    // signal on somebody who fat-fingered a word.
    const drift = classifyConfigDrift(base, with_({ preset: 'stnadard' }));
    expect(drift.direction).toBe('unchanged');
    expect(isDowngrade(drift)).toBe(false);
  });

  it('ignores an unrecognised sandbox tier in the same way', () => {
    const drift = classifyConfigDrift(base, with_({ sandboxTier: 'firejail' }));
    expect(drift.direction).toBe('unchanged');
  });

  it('names every change, not just the first', () => {
    const drift = classifyConfigDrift(
      with_({ mode: 'team', sandboxRequired: true }),
      with_({ preset: 'lite', mode: 'solo', sandboxRequired: false }),
    );
    expect(drift.changes.map((change) => change.field).sort()).toEqual([
      'mode',
      'preset',
      'sandboxRequired',
    ]);
    expect(drift.direction).toBe('weakened');
  });

  it('carries a `because` a person can read without the code', () => {
    const drift = classifyConfigDrift(base, with_({ preset: 'lite' }));
    expect(drift.because).toContain('standard → lite');
    expect(drift.because).toContain('weakened');
  });

  it('orders presets weakest-first, because the order is the definition', () => {
    expect(PRESET_STRENGTH).toEqual(['lite', 'standard', 'strict']);
  });
});
