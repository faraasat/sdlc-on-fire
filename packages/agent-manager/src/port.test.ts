import type { CanonicalSkill } from '@sdlc-on-fire/core';
import { describe, expect, it } from 'vitest';
import {
  CANONICAL_SKILL_FIELDS,
  compareSemver,
  missingCapabilityRows,
  supportsSchemaVersion,
  type AgentAdapter,
} from './port.js';

function adapter(overrides: Partial<AgentAdapter> = {}): AgentAdapter {
  return {
    id: 'test',
    maxSchemaVersion: '0.1.0',
    capabilityTable: CANONICAL_SKILL_FIELDS.map((field) => ({ field, support: 'mapped' as const })),
    compileSkill: () => ({ files: [], warnings: [] }),
    detect: () => Promise.resolve({ target: 'test', present: false, findings: [] }),
    ...overrides,
  };
}

const skill = { schema_version: '0.1.0' } as CanonicalSkill;

describe('capability-table totality', () => {
  it('passes when every canonical field is accounted for', () => {
    expect(missingCapabilityRows(adapter())).toEqual([]);
  });

  it('names the fields an adapter forgot', () => {
    // A forgotten `allowed_tools` would quietly compile away a security boundary.
    const partial = adapter({
      capabilityTable: [{ field: 'name', support: 'mapped' }],
    });
    const missing = missingCapabilityRows(partial);
    expect(missing).toContain('allowed_tools');
    expect(missing).toContain('hooks');
    expect(missing).not.toContain('name');
  });

  it('accepts dropped and passthrough as accounted-for', () => {
    // Explicitly dropping a field is compliant; silently ignoring it is not.
    const dropping = adapter({
      capabilityTable: CANONICAL_SKILL_FIELDS.map((field) => ({
        field,
        support: field === 'hooks' ? ('dropped' as const) : ('mapped' as const),
      })),
    });
    expect(missingCapabilityRows(dropping)).toEqual([]);
  });
});

describe('compareSemver', () => {
  it('orders numerically, not lexically', () => {
    // The bug this exists to prevent: '0.10.0' < '0.9.0' under string compare.
    expect(compareSemver('0.10.0', '0.9.0')).toBeGreaterThan(0);
  });

  it('treats equal versions as equal', () => {
    expect(compareSemver('1.2.3', '1.2.3')).toBe(0);
  });

  it('ignores prerelease suffixes for ordering', () => {
    expect(compareSemver('1.2.3-rc.1', '1.2.3')).toBe(0);
  });

  it('compares each segment', () => {
    expect(compareSemver('1.0.0', '0.99.99')).toBeGreaterThan(0);
    expect(compareSemver('1.2.0', '1.2.1')).toBeLessThan(0);
  });
});

describe('schema-version gating', () => {
  it('accepts a skill at or below the adapter version', () => {
    expect(supportsSchemaVersion(adapter(), skill)).toBe(true);
    expect(supportsSchemaVersion(adapter({ maxSchemaVersion: '0.2.0' }), skill)).toBe(true);
  });

  it('refuses a skill from the future', () => {
    // Guessing at unseen fields and compiling anyway is worse than refusing.
    expect(supportsSchemaVersion(adapter(), { schema_version: '0.2.0' } as CanonicalSkill)).toBe(
      false,
    );
  });
});
