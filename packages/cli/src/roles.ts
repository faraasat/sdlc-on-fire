import {
  MAX_CONCURRENCY,
  ORCHESTRATOR_KEY,
  ROLE_REGISTRY,
  registryViolationsFor,
  rolesForStack,
  type RoleDefinition,
} from '@sdlc-on-fire/core';
import { detectProjectStack } from './research.js';

/**
 * `sdlc roles` — the specialist team a project's stack implies (P2-AGENT-01,
 * ADR-0059).
 *
 * The registry, the role shape and `shouldSpawn` all shipped with P1-AGENT-09.
 * What was missing is the sentence ADR-0059 actually turns on: **the specialist
 * role set is derived from the detected stack, not hardcoded.** Until something
 * read a real project and produced a real team, "derived" was a property of a
 * function nobody called with real input — and the first time it was called
 * with some, the adversarial reviewer turned out never to have been included in
 * any team at all.
 *
 * Two things this reports beyond the list, both from the ADR's own risk
 * register rather than invented here:
 *
 * **Role explosion.** "A 6-technology stack could imply a dozen roles",
 * mitigated by the per-wave ceiling and by folding thin roles into the
 * orchestrator. So a derived team wider than the concurrency cap is reported as
 * a finding — it cannot all run at once, and a team that cannot be dispatched
 * is a plan rather than a team.
 *
 * **Technologies with no specialist.** The complement of the same problem, and
 * the more likely one: a project's real stack outruns the registry, and every
 * technology without a role is handled by the orchestrator generically. That is
 * often fine and it should never be silent, because the registry is *meant* to
 * grow additively and nothing else says where.
 */

export interface DerivedRole {
  readonly key: string;
  readonly persona: string;
  readonly tier: string;
  readonly tools: readonly string[];
  /** Which detected technologies summoned it. Empty for stack-independent roles. */
  readonly summonedBy: readonly string[];
}

export interface RolesResult {
  readonly technologies: readonly string[];
  readonly roles: readonly DerivedRole[];
  /** Technologies the registry has no specialist for. */
  readonly uncovered: readonly string[];
  /** Structural problems with the registry itself. */
  readonly violations: readonly string[];
  /** Populated when the derived team is wider than the concurrency cap. */
  readonly findings: readonly string[];
  readonly ok: boolean;
}

/** Which *technologies* summoned a role — reported by technology, matched on both. */
const summonedBy = (
  role: RoleDefinition,
  detected: readonly { tech: string; packages: readonly { name: string }[] }[],
): string[] =>
  role.triggers.includes('*')
    ? []
    : detected
        .filter((entry) =>
          [entry.tech, ...entry.packages.map((pkg) => pkg.name)].some((name) =>
            role.triggers.some((trigger) => trigger.toLowerCase() === name.toLowerCase()),
          ),
        )
        .map((entry) => entry.tech);

export async function deriveRoles(
  root: string,
  registry: readonly RoleDefinition[] = ROLE_REGISTRY,
): Promise<RolesResult> {
  // The same detector `research scan` and `mcp suggest` use — one idea of the
  // stack, so a team derived here matches the research asked for there.
  const { detected } = await detectProjectStack(root);
  const technologies = detected.map((tech) => tech.tech);

  // Matched on package names as well as technology names, the same way the MCP
  // catalogue is. A registry trigger is written by a person thinking about an
  // ecosystem (`drizzle`, `postgres`); a manifest says `drizzle-orm` and `pg`.
  // Nothing had ever compared the two vocabularies, because nothing had derived
  // a team from a real project.
  const matchable = [
    ...technologies,
    ...detected.flatMap((tech) => tech.packages.map((pkg) => pkg.name)),
  ];

  const roles = rolesForStack(registry, matchable).map((role) => ({
    key: role.key,
    persona: role.persona,
    tier: role.tier,
    tools: role.tools,
    summonedBy: summonedBy(role, detected),
  }));

  const covered = new Set(roles.flatMap((role) => role.summonedBy));
  const uncovered = technologies.filter((tech) => !covered.has(tech));

  const findings: string[] = [];
  const specialists = roles.filter((role) => role.key !== ORCHESTRATOR_KEY);
  if (specialists.length > MAX_CONCURRENCY) {
    findings.push(
      `${String(specialists.length)} specialists derived but at most ${String(MAX_CONCURRENCY)} ` +
        'can run at once — fold the thinnest into the orchestrator (ADR-0059 role explosion)',
    );
  }

  const violations = registryViolationsFor(registry);

  return {
    technologies,
    roles,
    uncovered,
    violations,
    findings,
    // A broken registry fails; an uncovered technology does not. The first is a
    // defect, the second is the registry not having grown yet — and conflating
    // them would make every real project's first run a failure.
    ok: violations.length === 0 && findings.length === 0,
  };
}

export function formatRoles(result: RolesResult): string {
  const lines = [
    `${String(result.roles.length)} role(s) for ${String(result.technologies.length)} detected technolog${result.technologies.length === 1 ? 'y' : 'ies'}`,
    '',
  ];

  for (const role of result.roles) {
    const why =
      role.key === ORCHESTRATOR_KEY
        ? 'always — it decomposes, dispatches and reconciles'
        : role.summonedBy.length === 0
          ? 'stack-independent'
          : `for ${role.summonedBy.join(', ')}`;
    lines.push(`  ${role.key.padEnd(14)} ${role.tier.padEnd(7)} ${why}`);
    lines.push(`  ${' '.repeat(14)} ${role.persona}`);
    lines.push(`  ${' '.repeat(14)} tools: ${role.tools.join(', ') || '(none — it directs)'}`);
    lines.push('');
  }

  for (const violation of result.violations) lines.push(`  ✗ ${violation}`);
  for (const finding of result.findings) lines.push(`  ✗ ${finding}`);

  if (result.uncovered.length > 0) {
    // Never silent. The registry is meant to grow additively and nothing else
    // says where.
    lines.push(
      `No specialist for: ${result.uncovered.join(', ')}.`,
      'The orchestrator handles those itself, which is often right — and is the',
      'list to read when adding a role.',
    );
  }
  return lines.join('\n');
}
