import type { EvidenceEnvelope, EvidenceKind } from '@sdlc-on-fire/core';
import { GatePolicySchema, type GatePolicy } from './evaluate-gate.js';

/**
 * Promoting the test taxonomy to blocking gate inputs (P2-QA-05, ADR-0044).
 *
 * v0.1 blocked on `test` + `typecheck` + `build` and ran dependency-audit as a
 * non-blocking CI check. ADR-0044 schedules the rest for Phase 2: richer
 * security scanning becomes a gate input, and the alternate-path/metamorphic
 * requirement becomes something a gate can actually check rather than a note in
 * a strategy doc.
 *
 * **Bound to presets, because a blocking set is a cost.** `lite` keeps exactly
 * the v0.1 three. A team on `lite` chose cheap, and quietly making cheap
 * expensive is how a preset stops meaning anything — the honest way to ask for
 * more checks is to ask for a different preset.
 *
 * **Metamorphic is a tag, not a kind.** `testing-strategy.md` is explicit: an
 * alternate-path test flows through the identical envelope and `evaluateGate`
 * machinery, distinguished by metadata rather than by a parallel structure.
 * Adding a `metamorphic` evidence kind would fork the pipeline for a property
 * that is about *what a test asserts*, not about what produced the evidence.
 */

/**
 * Required evidence per preset.
 *
 * `security-scan` arrives at `standard`. That placement is the argument worth
 * recording: a scanner that has not run produces *no* envelope, so promoting it
 * to blocking means an unconfigured scanner blocks the gate. That is the
 * intended behaviour — it is the same rule as everywhere else here, that not
 * having looked is not the same as having found nothing — but it does mean
 * turning on `standard` requires wiring a scanner first, and a team that cannot
 * yet should stay on `lite` deliberately rather than discover this in CI.
 */
const REQUIRED_EVIDENCE: Readonly<Record<string, readonly EvidenceKind[]>> = {
  lite: ['test', 'typecheck', 'build'],
  standard: ['test', 'typecheck', 'build', 'lint', 'security-scan'],
  strict: ['test', 'typecheck', 'build', 'lint', 'security-scan', 'e2e', 'coverage-delta'],
};

/**
 * Kinds whose evidence must describe the current tree, not merely exist.
 *
 * A security scan from three commits ago is the one most likely to be stale in
 * the way that matters: the commit that introduced the vulnerability is exactly
 * the commit the old scan did not see.
 */
const FRESH_REQUIRED = new Set<EvidenceKind>(['security-scan', 'e2e']);

export function taxonomyPolicy(preset: string): GatePolicy {
  const kinds = REQUIRED_EVIDENCE[preset] ?? REQUIRED_EVIDENCE['lite'] ?? [];
  return GatePolicySchema.parse({
    name: preset,
    evidence: kinds.map((kind) => ({
      kind,
      required: true,
      require_fresh: FRESH_REQUIRED.has(kind),
    })),
  });
}

/** The kinds this preset blocks on, for reporting without re-deriving. */
export function blockingKinds(preset: string): readonly EvidenceKind[] {
  return REQUIRED_EVIDENCE[preset] ?? REQUIRED_EVIDENCE['lite'] ?? [];
}

/** Presets that require at least one alternate-path case. */
const METAMORPHIC_PRESETS = new Set(['standard', 'strict']);

/**
 * Whether an envelope came from an alternate-path/metamorphic test.
 *
 * Read from the envelope's own metadata rather than inferred from the test
 * name. A title convention is a convention — it drifts, it gets translated, and
 * a gate keyed on it fails silently the first time somebody renames a describe
 * block.
 */
export function isMetamorphic(envelope: EvidenceEnvelope): boolean {
  const payload = envelope.payload as { metamorphic?: unknown } | null | undefined;
  return payload?.metamorphic === true;
}

export interface MetamorphicRequirement {
  readonly required: boolean;
  readonly satisfied: boolean;
  readonly count: number;
  readonly reason: string;
}

/**
 * Whether the alternate-path requirement is met.
 *
 * ADR-0044 asks for **at least one** — not a proportion. A single genuine
 * alternate-path case catches the mid-pipeline breakage a same-route suite
 * structurally cannot see; a quota would produce nine contrived ones and one
 * real one, and `testing-strategy.md` already warns these go flaky when the
 * "equivalent paths" are not truly equivalent.
 */
export function metamorphicRequirement(
  preset: string,
  envelopes: readonly EvidenceEnvelope[],
): MetamorphicRequirement {
  const required = METAMORPHIC_PRESETS.has(preset);
  const count = envelopes.filter(
    (envelope) => envelope.kind === 'test' && isMetamorphic(envelope),
  ).length;

  if (!required) {
    return {
      required: false,
      satisfied: true,
      count,
      reason: `${preset} does not require an alternate-path case`,
    };
  }

  return {
    required: true,
    satisfied: count > 0,
    count,
    reason:
      count > 0
        ? `${String(count)} alternate-path case(s) present`
        : 'no alternate-path case — a suite that only ever reaches a result one way cannot see that route breaking',
  };
}

export function formatTaxonomyPolicy(preset: string, requirement: MetamorphicRequirement): string {
  const lines = [`${preset} blocks on: ${blockingKinds(preset).join(', ')}`];
  lines.push(
    requirement.satisfied
      ? `✓ alternate-path: ${requirement.reason}`
      : `✗ alternate-path: ${requirement.reason}`,
  );
  return lines.join('\n');
}
