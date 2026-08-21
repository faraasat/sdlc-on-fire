import { describe, expect, it } from 'vitest';
import { GatePolicySourceSchema, type GatePolicySource } from './gate-policy-source.js';
import { formatSimulation, simulateGatePolicy } from './simulate-policy.js';

/** P3-RBAC-05 — what a proposed policy change would actually do. */

const policy = (over: Record<string, unknown> = {}): GatePolicySource =>
  GatePolicySourceSchema.parse({ name: 'p', ...over });

describe('counterexamples, not a summary', () => {
  it('names the concrete target where a requirement appears', () => {
    // The borrowed idea from Cedar Analysis. "The new set is more permissive" is
    // a fact nobody can act on; "high-risk features now need security" is.
    const result = simulateGatePolicy(
      [policy({ name: 'base' })],
      [
        policy({ name: 'base' }),
        policy({
          name: 'tight',
          applies_to: { risk_level: ['high'] },
          approvals: { required_roles: ['security'], min_approvals: 1 },
        }),
      ],
    );
    const delta = result.deltas.find((entry) => entry.target.riskLevel === 'high');
    expect(delta).toBeDefined();
    expect(delta?.changes).toContain('now requires "security"');
    expect(delta?.direction).toBe('stricter');
  });

  it('does not flag targets the change does not reach', () => {
    const result = simulateGatePolicy(
      [policy({ name: 'base' })],
      [
        policy({ name: 'base' }),
        policy({
          name: 'tight',
          applies_to: { risk_level: ['high'] },
          approvals: { required_roles: ['security'] },
        }),
      ],
    );
    expect(result.deltas.every((delta) => delta.target.riskLevel === 'high')).toBe(true);
  });
});

describe('a loosening is the finding that matters', () => {
  it('detects a requirement that stopped applying', () => {
    // The silent direction: a rule that stops applying raises nothing, and the
    // cards it stopped covering look exactly like cards it never covered.
    const before = [
      policy({
        name: 'sec',
        applies_to: { risk_level: ['high'] },
        approvals: { required_roles: ['security'] },
      }),
    ];
    const result = simulateGatePolicy(before, []);
    expect(result.deltas[0]?.changes).toContain('no longer requires "security"');
    expect(result.deltas[0]?.direction).toBe('looser');
  });

  it('detects a lowered approval floor', () => {
    const result = simulateGatePolicy(
      [policy({ approvals: { required_roles: [], min_approvals: 2 } })],
      [policy({ approvals: { required_roles: [], min_approvals: 1 } })],
    );
    expect(result.deltas[0]?.changes).toContain('approval floor 2 → 1');
    expect(result.deltas[0]?.direction).toBe('looser');
  });

  it('detects a widened override path', () => {
    const result = simulateGatePolicy(
      [policy({ overridable_by: [] })],
      [policy({ overridable_by: ['eng-lead'] })],
    );
    expect(result.deltas[0]?.direction).toBe('looser');
  });

  it('calls a change that both tightens and loosens mixed', () => {
    // Reporting one direction for this would be picking whichever reads better.
    const result = simulateGatePolicy(
      [policy({ approvals: { required_roles: ['qa'], min_approvals: 1 } })],
      [policy({ approvals: { required_roles: ['security'], min_approvals: 2 } })],
    );
    expect(result.deltas[0]?.direction).toBe('mixed');
  });

  it('says out loud that a loosening will not announce itself', () => {
    const result = simulateGatePolicy(
      [policy({ approvals: { required_roles: ['security'] } })],
      [policy()],
    );
    expect(formatSimulation(result)).toContain('will not announce itself');
  });
});

describe('the enumeration is honest about its edges', () => {
  it('probes at least once even for wildcard-only policies', () => {
    // "No differences" over an empty domain is the most convincing wrong answer
    // available, so the domain is never empty.
    const result = simulateGatePolicy([policy()], [policy()]);
    expect(result.probed).toBeGreaterThan(0);
    expect(result.identical).toBe(true);
  });

  it('reports the count alongside a no-difference answer', () => {
    expect(formatSimulation(simulateGatePolicy([policy()], [policy()]))).toContain('probed target');
  });

  it('builds the domain from the values the policies actually name', () => {
    const result = simulateGatePolicy(
      [policy({ applies_to: { work_type: ['bug'], risk_level: ['high'] } })],
      [policy({ applies_to: { work_type: ['feature'], risk_level: ['low'] } })],
    );
    expect([...result.domain.workTypes].sort()).toEqual(['bug', 'feature']);
    expect([...result.domain.riskLevels].sort()).toEqual(['high', 'low']);
  });

  it('names the edge of what it checked', () => {
    expect(formatSimulation(simulateGatePolicy([policy()], [policy()]))).toContain(
      'were not probed',
    );
  });

  it('probes path-scoped policies with a path that matches them', () => {
    // A policy scoped to `packages/db/**` only moves for a path under it; a
    // domain that never produced one would report no difference.
    const result = simulateGatePolicy(
      [policy({ name: 'base' })],
      [
        policy({ name: 'base' }),
        policy({
          name: 'db',
          applies_to: { path_pattern: ['packages/db/**'] },
          approvals: { required_roles: ['eng-lead'] },
        }),
      ],
    );
    expect(result.deltas.length).toBeGreaterThan(0);
    expect(result.deltas[0]?.changes).toContain('now requires "eng-lead"');
  });

  it('attributes a path-scoped change to the path it is scoped to', () => {
    // A probe domain that never produced a real path would still surface the
    // delta — `matchesTarget` treats an unknown change set as matching — but it
    // could not say *which* files it applies to, which is the only thing that
    // makes the counterexample actionable. Two differently-scoped policies, one
    // changing, and the delta must name the right one.
    const result = simulateGatePolicy(
      [
        policy({ name: 'db', applies_to: { path_pattern: ['packages/db/**'] } }),
        policy({ name: 'web', applies_to: { path_pattern: ['apps/web/**'] } }),
      ],
      [
        policy({
          name: 'db',
          applies_to: { path_pattern: ['packages/db/**'] },
          approvals: { required_roles: ['eng-lead'] },
        }),
        policy({ name: 'web', applies_to: { path_pattern: ['apps/web/**'] } }),
      ],
    );
    expect(result.deltas.length).toBeGreaterThan(0);
    for (const delta of result.deltas) {
      expect(delta.target.paths[0], JSON.stringify(delta.target)).toContain('packages/db');
    }
  });

  it('reports a change in which policies matched, even with the same requirement', () => {
    // Renaming or splitting a policy leaves the requirement identical and the
    // audit trail different; a diff that only compared requirements would say
    // nothing changed.
    const result = simulateGatePolicy([policy({ name: 'old' })], [policy({ name: 'new' })]);
    expect(result.deltas[0]?.changes.join(' ')).toContain('matched by');
  });
});
