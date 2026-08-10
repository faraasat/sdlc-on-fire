import { z } from 'zod';
import { SkillTierSchema } from './skill.js';

/**
 * The role registry and prompting profiles (P1-AGENT-09, ADR-0059/0060).
 *
 * A role is **not** flavour text. `.research/29` is blunt that persona
 * prompting has mixed evidence, and that the leverage is elsewhere: "You are a
 * Supabase expert" is worth close to nothing without Supabase-scoped context and
 * Supabase tools. So a role here is four things that actually constrain a run —
 * a scoped context pack, a restricted toolset, a tier, and a prompting profile —
 * and the persona line is the least of them.
 *
 * That is why {@link roleViolations} refuses a role with an empty toolset or an
 * empty context scope. A role that can see everything and use every tool is a
 * persona wearing a lanyard, and shipping one would make the registry look like
 * specialisation while providing none.
 *
 * **Derived from the detected stack, not hardcoded.** Adding a technology adds
 * its specialist additively (ADR-0059). The registry maps detection → role, so
 * a project without Supabase never has a Supabase specialist to spawn.
 *
 * **The technique is configuration, not a mid-run choice** (ADR-0060, ADR-0040).
 * A role declares its profile; the compiler renders it. A model deciding its own
 * technique at runtime would be the model choosing how it is evaluated.
 */

/** Techniques with research behind them for a task class (ADR-0060, papers/09). */
export const PROMPTING_TECHNIQUES = [
  'chain-of-thought',
  'react',
  'plan-and-solve',
  'decomposition',
  'self-consistency',
  'reflection',
  'few-shot',
  'skeleton-of-thought',
  'structured-output',
  'adversarial-framing',
  'citation',
] as const;
export const PromptingTechniqueSchema = z.enum(PROMPTING_TECHNIQUES);
export type PromptingTechnique = z.infer<typeof PromptingTechniqueSchema>;

/**
 * Techniques ADR-0060 marks as weak or mixed evidence.
 *
 * Allowed, and never load-bearing. Named here rather than left to judgement so
 * "used sparingly" is checkable instead of aspirational.
 */
export const WEAK_EVIDENCE_TECHNIQUES: readonly PromptingTechnique[] = ['few-shot'];

export const RoleDefinitionSchema = z
  .object({
    key: z.string().min(1),
    /** One line. The least load-bearing part of the role, and sized accordingly. */
    persona: z.string().min(1),
    /**
     * Detected technologies that summon this role. Empty means always-available
     * (the orchestrator itself); anything else is stack-derived.
     */
    triggers: z.array(z.string().min(1)).default([]),
    /** Glob/path scopes this role's context pack is built from. */
    contextScope: z.array(z.string().min(1)),
    /** Tools this role may use. The restriction is the specialisation. */
    tools: z.array(z.string().min(1)),
    tier: SkillTierSchema,
    techniques: z.array(PromptingTechniqueSchema).min(1),
  })
  .strict();

export type RoleDefinition = z.infer<typeof RoleDefinitionSchema>;

/** The orchestrator: the one role that coordinates rather than specialises. */
export const ORCHESTRATOR_KEY = 'orchestrator';

/**
 * Structural problems with a role, as lines.
 *
 * Returned rather than thrown so a registry can be reported on whole. Every
 * check here is about a role that would *look* like specialisation without
 * being any.
 */
export function roleViolations(role: RoleDefinition): readonly string[] {
  const problems: string[] = [];

  if (role.key !== ORCHESTRATOR_KEY) {
    if (role.contextScope.length === 0) {
      problems.push(
        `"${role.key}" scopes no context — a specialist that sees everything is a persona, ` +
          'and persona prompting is the part with the weakest evidence behind it',
      );
    }
    if (role.tools.length === 0) {
      problems.push(
        `"${role.key}" restricts no tools — the restriction is where the specialisation lives`,
      );
    }
    // Never Fable/top-tier for subagents (ADR-0028); the orchestrator is the
    // higher-tier reasoner and specialists are not.
    if (role.tier === 'high') {
      problems.push(
        `"${role.key}" is a specialist at the high tier — high is reserved for the orchestrator ` +
          'and for rare hard reasoning (ADR-0028/0029)',
      );
    }
  }

  if (role.techniques.every((technique) => WEAK_EVIDENCE_TECHNIQUES.includes(technique))) {
    problems.push(
      `"${role.key}" relies only on techniques with weak evidence (${role.techniques.join(', ')}) — ` +
        'ADR-0060 allows them sparingly and never load-bearing',
    );
  }

  return problems;
}

/** The whole registry's problems, so a bad role cannot hide behind a good one. */
export function registryViolationsFor(roles: readonly RoleDefinition[]): readonly string[] {
  const problems = roles.flatMap((role) => roleViolations(role));
  const seen = new Set<string>();
  for (const role of roles) {
    if (seen.has(role.key)) problems.push(`duplicate role key: ${role.key}`);
    seen.add(role.key);
  }
  if (!seen.has(ORCHESTRATOR_KEY)) {
    problems.push(
      'no orchestrator — uncoordinated fan-out is what centralized coordination replaces (papers/06)',
    );
  }
  return problems;
}

/**
 * Roles a detected stack actually summons.
 *
 * The orchestrator is always present; everything else has to be triggered.
 * Spawning a specialist that nothing in the project needs is the role explosion
 * ADR-0029 caps against.
 */
export function rolesForStack(
  registry: readonly RoleDefinition[],
  detected: readonly string[],
): readonly RoleDefinition[] {
  const stack = new Set(detected.map((entry) => entry.toLowerCase()));
  return registry.filter(
    (role) =>
      role.key === ORCHESTRATOR_KEY ||
      role.triggers.some((trigger) => stack.has(trigger.toLowerCase())),
  );
}

/** The shipped registry. Data — adding a technology adds a row (ADR-0059). */
export const ROLE_REGISTRY: readonly RoleDefinition[] = [
  RoleDefinitionSchema.parse({
    key: ORCHESTRATOR_KEY,
    persona: 'Principal engineer who decomposes, dispatches and reconciles.',
    contextScope: [],
    tools: [],
    // The one higher-tier reasoner. Everything it dispatches to is not.
    tier: 'high',
    techniques: ['plan-and-solve', 'decomposition', 'reflection'],
  }),
  RoleDefinitionSchema.parse({
    key: 'typescript',
    persona: 'TypeScript engineer working to the project’s own conventions.',
    triggers: ['typescript', 'ts', 'node'],
    contextScope: ['**/*.ts', 'tsconfig*.json', 'package.json'],
    tools: ['read', 'edit', 'run-tests'],
    tier: 'medium',
    techniques: ['chain-of-thought', 'structured-output'],
  }),
  RoleDefinitionSchema.parse({
    key: 'sql',
    persona: 'Database engineer who treats a migration as irreversible.',
    triggers: ['postgres', 'sql', 'pglite', 'drizzle'],
    contextScope: ['**/*.sql', '**/schema.ts', '**/migrations/**'],
    tools: ['read', 'edit'],
    tier: 'medium',
    techniques: ['plan-and-solve', 'structured-output'],
  }),
  RoleDefinitionSchema.parse({
    key: 'react',
    persona: 'Frontend engineer who checks what the user actually sees.',
    triggers: ['react', 'next', 'vite'],
    contextScope: ['**/*.tsx', '**/*.css'],
    tools: ['read', 'edit', 'screenshot'],
    tier: 'medium',
    techniques: ['chain-of-thought', 'reflection'],
  }),
  RoleDefinitionSchema.parse({
    key: 'reviewer',
    persona: 'Adversarial reviewer trying to break the change.',
    triggers: ['*'],
    contextScope: ['**/*'],
    tools: ['read', 'run-tests'],
    tier: 'medium',
    techniques: ['reflection', 'adversarial-framing'],
  }),
];

export type SpawnDecision =
  | { readonly spawn: true; readonly role: string; readonly reason: string }
  | { readonly spawn: false; readonly reason: string };

/**
 * Whether a piece of work earns a specialist.
 *
 * Multi-agent is not the default (papers/06). A spawn has to buy something —
 * parallelism, context isolation, or genuine specialisation — and work that
 * buys none of those is cheaper and better done by the orchestrator directly,
 * because a subagent costs a dispatch, a context pack and a summary before it
 * has helped with anything.
 */
export function shouldSpawn(input: {
  readonly role: RoleDefinition;
  /** Other work that can run at the same time. */
  readonly parallelWith: number;
  /** Whether this work would otherwise pollute the orchestrator's context. */
  readonly isolatesContext: boolean;
  /** Whether the role's scoped tools/context are actually needed. */
  readonly needsSpecialisation: boolean;
}): SpawnDecision {
  if (input.parallelWith > 0) {
    return { spawn: true, role: input.role.key, reason: 'runs in parallel with other work' };
  }
  if (input.isolatesContext) {
    return {
      spawn: true,
      role: input.role.key,
      reason: 'keeps a large read out of the orchestrator’s context',
    };
  }
  if (input.needsSpecialisation) {
    return {
      spawn: true,
      role: input.role.key,
      reason: `needs ${input.role.key}'s scoped context and tools`,
    };
  }
  return {
    spawn: false,
    reason:
      'buys no parallelism, no context isolation and no specialisation — the orchestrator does ' +
      'this itself rather than paying a dispatch, a context pack and a summary first',
  };
}
