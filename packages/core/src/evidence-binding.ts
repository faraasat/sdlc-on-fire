/**
 * What evidence actually satisfied which gate (P3-KAN-03).
 *
 * The `gate_evidence` join has existed since Phase 0 and nothing read it. That
 * matters more here than it would in most products, because the whole claim of
 * this one is that a gate passed *for a reason you can inspect*. A gate showing
 * green with no way to see the envelope behind it is indistinguishable from a
 * gate that was simply told to be green — which is the thing the product exists
 * to refuse from an agent, made by the product about itself.
 *
 * Three questions the binding answers, and each has a distinct wrong answer
 * that looks fine:
 *
 * - **Unbound evidence**: produced, stored, and attached to no gate. It looks
 *   like coverage in a list and satisfies nothing.
 * - **Unsupported gate**: passing with no evidence behind it at all.
 * - **Stale binding**: evidence bound to a gate but produced against a
 *   different commit, so it describes code that is no longer there.
 */

export interface EvidenceRow {
  readonly id: number;
  readonly kind: string;
  readonly producer: string;
  readonly git_sha: string;
  readonly confidence: number | string;
  readonly produced_at: string;
  readonly expires_at?: string | null;
}

export interface GateRow {
  readonly id: number;
  readonly gate_name: string;
  readonly result: string | null;
}

export interface GateEvidenceLink {
  readonly gate_id: number;
  readonly evidence_id: number;
}

export const BINDING_PROBLEMS = [
  'unsupported-gate',
  'stale-evidence',
  'expired-evidence',
  'unbound-evidence',
] as const;
export type BindingProblem = (typeof BINDING_PROBLEMS)[number];

export interface BoundGate {
  readonly gate: GateRow;
  readonly evidence: readonly EvidenceRow[];
  readonly problems: readonly { readonly problem: BindingProblem; readonly because: string }[];
}

export interface BindingReport {
  readonly gates: readonly BoundGate[];
  /** Evidence attached to no gate — stored, and satisfying nothing. */
  readonly unbound: readonly EvidenceRow[];
  readonly problemCount: number;
}

/**
 * Bind evidence to gates and report what does not add up.
 *
 * `headSha` is required rather than optional. Staleness is the failure this is
 * most for — evidence describing code that has since changed — and making the
 * comparison skippable would make the check disappear exactly where somebody
 * did not have the sha to hand.
 */
export function bindEvidence(input: {
  readonly gates: readonly GateRow[];
  readonly evidence: readonly EvidenceRow[];
  readonly links: readonly GateEvidenceLink[];
  readonly headSha: string;
  readonly now?: Date;
}): BindingReport {
  const now = input.now ?? new Date();
  const byId = new Map(input.evidence.map((row) => [row.id, row]));
  const bound = new Set<number>();

  const gates: BoundGate[] = input.gates.map((gate) => {
    const linked = input.links
      .filter((link) => link.gate_id === gate.id)
      .map((link) => byId.get(link.evidence_id))
      .filter((row): row is EvidenceRow => row !== undefined);

    for (const row of linked) bound.add(row.id);

    const problems: { problem: BindingProblem; because: string }[] = [];

    if (linked.length === 0 && gate.result === 'pass') {
      problems.push({
        problem: 'unsupported-gate',
        because: `${gate.gate_name} is passing with no evidence bound to it`,
      });
    }

    for (const row of linked) {
      if (row.git_sha !== input.headSha) {
        problems.push({
          problem: 'stale-evidence',
          because:
            `${row.kind} was produced against ${row.git_sha.slice(0, 8)}, not ${input.headSha.slice(0, 8)} — ` +
            'it describes code that is no longer there',
        });
      }
      if (row.expires_at != null) {
        const expires = Date.parse(row.expires_at);
        if (!Number.isNaN(expires) && expires < now.getTime()) {
          problems.push({
            problem: 'expired-evidence',
            because: `${row.kind} expired at ${row.expires_at}`,
          });
        }
      }
    }

    return { gate, evidence: linked, problems };
  });

  const unbound = input.evidence.filter((row) => !bound.has(row.id));

  return {
    gates,
    unbound,
    problemCount: gates.reduce((sum, entry) => sum + entry.problems.length, 0) + unbound.length,
  };
}

/** A one-line verdict per gate, for a card face or a drawer heading. */
export function summariseBinding(bound: BoundGate): string {
  if (bound.problems.length > 0) return bound.problems[0]?.because ?? 'unknown problem';
  if (bound.evidence.length === 0) return 'no evidence yet';
  return `${String(bound.evidence.length)} envelope(s): ${bound.evidence.map((row) => row.kind).join(', ')}`;
}
