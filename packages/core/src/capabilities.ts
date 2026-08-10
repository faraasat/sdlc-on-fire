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

/**
 * Whether turning a flag on actually does anything yet.
 *
 * A blind evaluation turned three capabilities on, confirmed via `sdlc config`
 * that they read `enabled: true`, and observed no behaviour change of any kind —
 * because no code reads them. Every flag in this registry is in that state
 * today. Reporting `enabled: true` for a switch wired to nothing is the most
 * expensive kind of lie a tool can tell: the user proceeds believing a
 * protection is on.
 *
 * So the registry states it. `declared` means the decision is made and the
 * behaviour is not built; `active` means code actually reads the flag.
 */
export type CapabilityStatus = 'declared' | 'active';

export interface CapabilityDefinition {
  readonly key: string;
  readonly summary: string;
  /** Which of a–e this triggers. Never empty — a flag with no trigger is a default. */
  readonly costClasses: readonly CostClass[];
  /** The decision that justifies it, so a reviewer can go read the argument. */
  readonly adr: string;
  /** Always false. Present so `config --json` shows the default beside the value. */
  readonly defaultValue: false;
  /** Whether any code reads this flag yet. */
  readonly status: CapabilityStatus;
  /** The task that wires it, while it is still `declared`. */
  readonly implementedBy?: string | undefined;
}

function capability(
  key: string,
  summary: string,
  costClasses: readonly CostClass[],
  adr: string,
  implementedBy?: string,
): CapabilityDefinition {
  return {
    key,
    summary,
    costClasses,
    adr,
    defaultValue: false,
    // A capability is `declared` until something reads it. Deriving the status
    // from the presence of the task rather than declaring both keeps them from
    // disagreeing: wiring a flag means deleting its task argument, in the same
    // edit as the code that reads it.
    status: implementedBy === undefined ? 'active' : 'declared',
    ...(implementedBy === undefined ? {} : { implementedBy }),
  };
}

/**
 * The registry (ADR-0067 §4 — illustrative there, concrete here).
 *
 * Adding a row is how a capability becomes discoverable; there is no other way
 * to enable one, so a behaviour that is not listed cannot be switched on.
 */
export const ADVANCED_CAPABILITIES: readonly CapabilityDefinition[] = [
  // Wired (P1-AGENT-10): `lensesForReview` reads this. Off means one advisory
  // lens plus the gating one — fan-out multiplies cost, and ADR-0066's own
  // argument cuts both ways, since correlated lenses are worse than a single one.
  capability(
    'multi_lens_review',
    'Adversarial review across more than one advisory lens (fan-out > 1).',
    ['a', 'b'],
    'ADR-0066',
  ),
  capability(
    'cross_model_review',
    'Route review to a second configured provider rather than the same model.',
    ['a'],
    'ADR-0037',
    'P1-AGENT-10',
  ),
  capability(
    'high_subagent_concurrency',
    'Raise subagent concurrency above the conservative default.',
    ['a'],
    'ADR-0029',
    'P1-AGENT-08',
  ),
  capability(
    'api_embedder',
    'Use a hosted embedding API instead of the local model.',
    ['d'],
    'ADR-0004',
    'P1-CTX-04',
  ),
  capability(
    'telemetry_export',
    'Export OpenTelemetry traces off the machine.',
    ['d'],
    'ADR-0020',
    'P2-OBS-01',
  ),
  capability(
    'elevated_sandbox',
    'Raise the sandbox tier or broaden the command allowlist.',
    ['c'],
    'ADR-0036',
    'P1-SEC-02',
  ),
  capability(
    'unattended_mode',
    'Long-run mode with reduced human touchpoints.',
    ['c'],
    'ADR-0049',
    'P2-RUN-01',
  ),
  capability(
    'self_improvement_loop',
    'Bounded self-improvement loop. Stays human-gated even when enabled.',
    ['c'],
    'ADR-0026',
    'P2-SELF-01',
  ),
  capability(
    'teammate_memory',
    'Persistent per-teammate memory across sessions.',
    ['e'],
    'ADR-0065',
    'P1-OBJ-04',
  ),
  capability('strict_preset', 'The `strict` lifecycle preset.', ['b'], 'ADR-0008', 'P1-LIFE-06'),
  // Wired (P1-GATE-04): `sdlc advance` reads this and adds `knowledge-claim` to
  // the required evidence kinds. The task argument is gone because the code that
  // reads the flag now exists — which is the only thing that ever moves a
  // capability off `declared`.
  capability('knowledge_claim_gate', 'The knowledge-claim evidence gate.', ['b'], 'ADR-0019'),
  // Wired (P1-GATE-07): the gate runs soft on every workspace; this flag makes
  // its findings *block*, which is a different statement from choosing the
  // strict preset. Both reach the same place; neither implies the other.
  capability(
    'definition_of_ready_gate',
    'Enforce the Definition-of-Ready gate — findings block instead of warning.',
    ['b'],
    'ADR-0031',
  ),
  capability(
    'connected_database',
    'Connect to a user-supplied Postgres endpoint instead of bundled PGlite.',
    ['a'],
    'ADR-0068',
    'P1-DB-01',
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

/**
 * Capabilities that are on but wired to nothing.
 *
 * Surfaced everywhere the config is displayed. Someone who turned on
 * `knowledge_claim_gate` and saw `enabled: true` is entitled to know that no
 * code reads it yet — otherwise they proceed believing a protection is running,
 * which is worse than never having offered the switch.
 */
export function inertCapabilities(config: AdvancedConfig): readonly CapabilityDefinition[] {
  return ADVANCED_CAPABILITIES.filter(
    (entry) => config[entry.key] === true && entry.status === 'declared',
  );
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
