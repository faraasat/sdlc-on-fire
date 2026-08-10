import { describe, expect, it } from 'vitest';
import {
  ORCHESTRATOR_KEY,
  ROLE_REGISTRY,
  RoleDefinitionSchema,
  registryViolationsFor,
  roleViolations,
  rolesForStack,
  shouldSpawn,
  type RoleDefinition,
} from './role-registry.js';

/**
 * P1-AGENT-09 — the role registry (ADR-0059/0060).
 *
 * The point of every check here is that a role must be a *constraint*, not a
 * persona. `.research/29` is blunt that persona prompting has mixed evidence and
 * that the leverage is scoped context plus restricted tools.
 */

const role = (over: Partial<RoleDefinition> = {}): RoleDefinition =>
  RoleDefinitionSchema.parse({
    key: 'sql',
    persona: 'Database engineer.',
    triggers: ['postgres'],
    contextScope: ['**/*.sql'],
    tools: ['read', 'edit'],
    tier: 'medium',
    techniques: ['plan-and-solve'],
    ...over,
  });

describe('a role must constrain something', () => {
  it('refuses a specialist that scopes no context', () => {
    const problems = roleViolations(role({ contextScope: [] }));
    // A specialist that sees everything is a persona, and persona prompting is
    // the part with the weakest evidence behind it.
    expect(problems.join(' ')).toContain('scopes no context');
  });

  it('refuses a specialist that restricts no tools', () => {
    expect(roleViolations(role({ tools: [] })).join(' ')).toContain('restricts no tools');
  });

  it('refuses a high-tier specialist', () => {
    // High is the orchestrator's, and rare hard reasoning's (ADR-0028/0029).
    expect(roleViolations(role({ tier: 'high' })).join(' ')).toContain('high tier');
  });

  it('lets the orchestrator be unscoped and high-tier', () => {
    const orchestrator = role({
      key: ORCHESTRATOR_KEY,
      contextScope: [],
      tools: [],
      tier: 'high',
      triggers: [],
    });
    expect(roleViolations(orchestrator)).toEqual([]);
  });

  it('refuses a role leaning only on weak-evidence techniques', () => {
    const problems = roleViolations(role({ techniques: ['few-shot'] }));
    // "Used sparingly" has to be checkable, not aspirational.
    expect(problems.join(' ')).toContain('weak evidence');
  });
});

describe('the shipped registry', () => {
  it('has no structural violations', () => {
    expect(registryViolationsFor(ROLE_REGISTRY)).toEqual([]);
  });

  it('has exactly one orchestrator', () => {
    expect(ROLE_REGISTRY.filter((entry) => entry.key === ORCHESTRATOR_KEY)).toHaveLength(1);
  });

  it('reports a registry with no coordinator', () => {
    const problems = registryViolationsFor(ROLE_REGISTRY.filter((r) => r.key !== ORCHESTRATOR_KEY));
    // Uncoordinated fan-out is what centralized coordination replaces.
    expect(problems.join(' ')).toContain('no orchestrator');
  });

  it('reports a duplicate key rather than letting one shadow the other', () => {
    expect(registryViolationsFor([...ROLE_REGISTRY, role({ key: 'sql' })]).join(' ')).toContain(
      'duplicate role key',
    );
  });
});

describe('roles are summoned by the stack', () => {
  it('brings only what the project actually uses', () => {
    const roles = rolesForStack(ROLE_REGISTRY, ['postgres', 'typescript']).map((r) => r.key);
    expect(roles).toContain('sql');
    expect(roles).toContain('typescript');
    // Spawning a React specialist on a CLI project is the role explosion
    // ADR-0029 caps against.
    expect(roles).not.toContain('react');
  });

  it('always includes the orchestrator', () => {
    expect(rolesForStack(ROLE_REGISTRY, []).map((r) => r.key)).toEqual([ORCHESTRATOR_KEY]);
  });
});

describe('shouldSpawn', () => {
  const sql = role();

  it('refuses a spawn that buys nothing', () => {
    const decision = shouldSpawn({
      role: sql,
      parallelWith: 0,
      isolatesContext: false,
      needsSpecialisation: false,
    });
    // A subagent costs a dispatch, a context pack and a summary before it has
    // helped with anything. Multi-agent is not the default (papers/06).
    expect(decision.spawn).toBe(false);
  });

  it('spawns for parallelism, isolation or specialisation', () => {
    expect(
      shouldSpawn({
        role: sql,
        parallelWith: 2,
        isolatesContext: false,
        needsSpecialisation: false,
      }).spawn,
    ).toBe(true);
    expect(
      shouldSpawn({ role: sql, parallelWith: 0, isolatesContext: true, needsSpecialisation: false })
        .spawn,
    ).toBe(true);
    expect(
      shouldSpawn({ role: sql, parallelWith: 0, isolatesContext: false, needsSpecialisation: true })
        .spawn,
    ).toBe(true);
  });
});
