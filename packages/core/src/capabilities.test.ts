import { describe, expect, it } from 'vitest';
import {
  ADVANCED_CAPABILITIES,
  AdvancedConfigSchema,
  CAPABILITY_KEYS,
  describeCapabilities,
  enabledCapabilities,
  registryViolations,
} from './capabilities.js';

/**
 * The advanced-capability registry (P0-OBJ-04, ADR-0067).
 *
 * These are structural assertions about the registry itself. The ADR's
 * guarantees — default-off, no master switch, every flag justified — are only
 * real if something checks them, and a master switch added later would look
 * like an ordinary row to a reviewer skimming a diff.
 */

describe('the registry holds its own invariants', () => {
  it('has no structural violations', () => {
    expect(registryViolations()).toEqual([]);
  });

  it('ships every capability off', () => {
    // The governing principle: the default configuration is the one where
    // being wrong is cheapest.
    const defaults = AdvancedConfigSchema.parse({});
    for (const key of CAPABILITY_KEYS) {
      expect(defaults[key], key).toBe(false);
    }
    expect(enabledCapabilities(defaults)).toEqual([]);
  });

  it('gives every capability at least one cost class', () => {
    // A flag with no trigger has no reason not to be a default.
    for (const entry of ADVANCED_CAPABILITIES) {
      expect(entry.costClasses.length, entry.key).toBeGreaterThan(0);
    }
  });

  it('points every capability at a resolvable ADR', () => {
    for (const entry of ADVANCED_CAPABILITIES) {
      expect(entry.adr, entry.key).toMatch(/^ADR-\d{4}$/);
    }
  });
});

describe('no master switch', () => {
  it('rejects advanced.all rather than treating it as unknown-but-harmless', () => {
    // Convenience here would defeat the point: fifteen behaviours enabled
    // without meeting fifteen descriptions.
    expect(AdvancedConfigSchema.safeParse({ all: true }).success).toBe(false);
  });

  it('has no capability key that enables in bulk', () => {
    for (const key of CAPABILITY_KEYS) {
      expect(['all', 'everything', 'enable_all', 'full']).not.toContain(key);
    }
  });

  it('rejects a typo rather than silently ignoring it', () => {
    // A typo'd flag that does nothing is the worst outcome available: the user
    // believes a capability is on and every later decision rests on that.
    expect(AdvancedConfigSchema.safeParse({ strict_presets: true }).success).toBe(false);
    expect(AdvancedConfigSchema.safeParse({ strict_preset: true }).success).toBe(true);
  });
});

describe('discovery output', () => {
  it('lists every flag, not only the enabled ones', () => {
    // "Advanced" must mean deliberate, not hidden.
    const rows = describeCapabilities(AdvancedConfigSchema.parse({ strict_preset: true }));
    expect(rows).toHaveLength(ADVANCED_CAPABILITIES.length);
    expect(rows.filter((row) => row.enabled)).toHaveLength(1);
  });

  it('shows the default beside the current value', () => {
    const rows = describeCapabilities(AdvancedConfigSchema.parse({ strict_preset: true }));
    const strict = rows.find((row) => row.key === 'strict_preset');
    expect(strict?.enabled).toBe(true);
    expect(strict?.defaultValue).toBe(false);
    expect(strict?.adr).toBe('ADR-0008');
  });
});

describe('what gets written to the audit log at run start', () => {
  it('reports the enabled set, sorted and stable', () => {
    // A finding produced under cross-model review is not the same evidence as
    // one produced under a single same-model pass, and a reader six months
    // later must be able to tell which they are looking at.
    const config = AdvancedConfigSchema.parse({
      cross_model_review: true,
      strict_preset: true,
    });
    expect(enabledCapabilities(config)).toEqual(['cross_model_review', 'strict_preset']);
  });
});
