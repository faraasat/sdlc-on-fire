import { z } from 'zod';

/**
 * The advanced-capability registry (P0-OBJ-04, ADR-0067).
 *
 * Everything here is **off by default**, and the rule for why — not the list —
 * is the decision: a capability ships off if it multiplies cost, adds
 * human-facing volume, widens agency, sends anything off the machine, or
 * persists state that can silently go stale. The governing principle is that
 * the default configuration should be the one where being wrong is cheapest.
 *
 * Two structural properties this module exists to guarantee:
 *
 * 1. **There is no master switch.** No `advanced.all`. Enabling is per-flag so a
 *    user cannot turn on fifteen behaviours without meeting fifteen
 *    descriptions. Convenience here would defeat the entire point, so the
 *    absence is enforced by a check rather than left to discipline.
 * 2. **Every flag carries its ADR and cost class.** A flag whose justification
 *    lives only in someone's memory is a flag nobody can review later.
 */

/** Why a capability cannot be a default (ADR-0067 §1). A flag may trigger several. */
export const COST_CLASSES = ['a', 'b', 'c', 'd', 'e'] as const;
export const CostClassSchema = z.enum(COST_CLASSES);
export type CostClass = z.infer<typeof CostClassSchema>;

export const COST_CLASS_MEANING: Readonly<Record<CostClass, string>> = {
  a: 'multiplies token or wall-clock cost',
  b: 'adds human-facing volume (questions, gates, approvals)',
  c: 'widens agency or permissions',
  d: 'sends something off the machine',
  e: 'persists state that can silently go stale',
};

export interface CapabilityDefinition {
  readonly key: string;
  readonly summary: string;
  /** Which of a–e this triggers. Never empty — a flag with no trigger is a default. */
  readonly costClasses: readonly CostClass[];
  /** The decision that justifies it, so a reviewer can go read the argument. */
  readonly adr: string;
  /** Always false. Present so `config --json` shows the default beside the value. */
  readonly defaultValue: false;
}

function capability(
  key: string,
  summary: string,
  costClasses: readonly CostClass[],
  adr: string,
): CapabilityDefinition {
  return { key, summary, costClasses, adr, defaultValue: false };
}

/**
 * The registry (ADR-0067 §4 — illustrative there, concrete here).
 *
 * Adding a row is how a capability becomes discoverable; there is no other way
 * to enable one, so a behaviour that is not listed cannot be switched on.
 */
export const ADVANCED_CAPABILITIES: readonly CapabilityDefinition[] = [
  capability(
    'multi_lens_review',
    'Adversarial review across more than one lens (fan-out > 1).',
    ['a', 'b'],
    'ADR-0066',
  ),
  capability(
    'cross_model_review',
    'Route review to a second configured provider rather than the same model.',
    ['a'],
    'ADR-0037',
  ),
  capability(
    'high_subagent_concurrency',
    'Raise subagent concurrency above the conservative default.',
    ['a'],
    'ADR-0029',
  ),
  capability(
    'api_embedder',
    'Use a hosted embedding API instead of the local model.',
    ['d'],
    'ADR-0004',
  ),
  capability('telemetry_export', 'Export OpenTelemetry traces off the machine.', ['d'], 'ADR-0020'),
  capability(
    'elevated_sandbox',
    'Raise the sandbox tier or broaden the command allowlist.',
    ['c'],
    'ADR-0036',
  ),
  capability('unattended_mode', 'Long-run mode with reduced human touchpoints.', ['c'], 'ADR-0049'),
  capability(
    'self_improvement_loop',
    'Bounded self-improvement loop. Stays human-gated even when enabled.',
    ['c'],
    'ADR-0026',
  ),
  capability(
    'teammate_memory',
    'Persistent per-teammate memory across sessions.',
    ['e'],
    'ADR-0065',
  ),
  capability('strict_preset', 'The `strict` lifecycle preset.', ['b'], 'ADR-0008'),
  capability('knowledge_claim_gate', 'The knowledge-claim evidence gate.', ['b'], 'ADR-0019'),
  capability('definition_of_ready_gate', 'The Definition-of-Ready gate.', ['b'], 'ADR-0031'),
  capability(
    'connected_database',
    'Connect to a user-supplied Postgres endpoint instead of bundled PGlite.',
    ['a'],
    'ADR-0068',
  ),
];

/** Reserved keys that must never become capabilities — the master switch, by any name. */
const FORBIDDEN_KEYS = new Set(['all', 'everything', 'enable_all', 'full']);

export const CAPABILITY_KEYS = ADVANCED_CAPABILITIES.map((entry) => entry.key);

/**
 * `advanced:` in `.sdlcof/config.yaml`.
 *
 * Unknown keys are rejected rather than ignored. A typo'd flag that silently
 * does nothing is the worst outcome available: the user believes a capability
 * is on, and every later decision rests on that belief.
 */
export const AdvancedConfigSchema = z
  .object(Object.fromEntries(CAPABILITY_KEYS.map((key) => [key, z.boolean().default(false)])))
  .strict()
  .prefault({});

export type AdvancedConfig = z.infer<typeof AdvancedConfigSchema>;

export function capabilityByKey(key: string): CapabilityDefinition | undefined {
  return ADVANCED_CAPABILITIES.find((entry) => entry.key === key);
}

/** Every key a user has turned on, sorted — the set recorded to the audit log at run start. */
export function enabledCapabilities(config: AdvancedConfig): readonly string[] {
  return CAPABILITY_KEYS.filter((key) => config[key] === true).sort();
}

export interface CapabilityDiscoveryRow extends CapabilityDefinition {
  readonly enabled: boolean;
}

/**
 * The `config --json` discovery surface.
 *
 * "Advanced" has to mean *deliberate*, not *hidden* — so every flag is listed
 * with its default, its current value, its ADR and its cost class, whether or
 * not it is on.
 */
export function describeCapabilities(config: AdvancedConfig): readonly CapabilityDiscoveryRow[] {
  return ADVANCED_CAPABILITIES.map((entry) => ({ ...entry, enabled: config[entry.key] === true }));
}

/**
 * Structural checks on the registry itself, run as a test.
 *
 * These are the properties ADR-0067 depends on, and none of them is safe to
 * leave as an intention: a master switch added later would look like an
 * ordinary row.
 */
export function registryViolations(): readonly string[] {
  const problems: string[] = [];
  const seen = new Set<string>();

  for (const entry of ADVANCED_CAPABILITIES) {
    if (seen.has(entry.key)) problems.push(`duplicate capability key: ${entry.key}`);
    seen.add(entry.key);

    if (FORBIDDEN_KEYS.has(entry.key)) {
      problems.push(`"${entry.key}" is a master switch — ADR-0067 forbids enabling in bulk`);
    }
    if (entry.costClasses.length === 0) {
      problems.push(
        `"${entry.key}" declares no cost class, so it has no reason not to be a default`,
      );
    }
    if (!/^ADR-\d{4}$/.test(entry.adr)) {
      problems.push(`"${entry.key}" has no resolvable ADR reference (got "${entry.adr}")`);
    }
    if (entry.defaultValue !== false) {
      problems.push(`"${entry.key}" is not default-off`);
    }
  }

  return problems;
}
