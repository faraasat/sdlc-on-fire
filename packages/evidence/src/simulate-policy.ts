import type { GatePolicySource, PolicyTarget } from './gate-policy-source.js';
import { matchPolicies } from './gate-policy-source.js';
import { normaliseQuorum, type QuorumRequirement } from './quorum.js';

/**
 * `simulateGatePolicy()` — what a proposed policy change would actually do
 * (P3-RBAC-05, ADR-0035, FEAT-RBAC-015).
 *
 * The problem ADR-0035 names is that editing `gate_policies` is a blind change:
 * a YAML diff shows what the *text* did, and nothing shows which cards start or
 * stop being blocked. Governance changes are exactly where "it looked right" is
 * worth least, because the failure is silent in the safe-looking direction —
 * a rule that stops applying does not raise anything.
 *
 * **The design is stolen from Cedar Analysis, and the borrowed idea is not
 * SMT.** AWS's toolkit compiles Cedar policies to SMT and, when two policy sets
 * differ, returns *a concrete request on which they differ* rather than a
 * verdict about permissiveness (~[AWS, *Introducing Cedar Analysis*](https://aws.amazon.com/blogs/opensource/introducing-cedar-analysis-open-source-tools-for-verifying-authorization-policies/);
 * [Cedar, PACMPL 2024](https://dl.acm.org/doi/full/10.1145/3649835)). That
 * counterexample is the whole value: "the new set is more permissive" is a fact
 * nobody can act on; "FEAT-014 stops requiring a security review" is.
 *
 * **What we deliberately do not borrow is the solver.** ADR-0010 capped this
 * model at roughly eight roles precisely so it would stay small, and the
 * consequence is that our decision space is *finite and tiny* — work types ×
 * risk levels × the path patterns the policies themselves name. So we
 * **enumerate it exhaustively**, which over a small finite domain is not an
 * approximation of the symbolic analysis: it is a complete one, with no encoding
 * to get wrong and no solver to depend on. Adopting an SMT pipeline here would
 * buy soundness we already have and cost the second policy representation
 * ADR-0010 rejected.
 *
 * The obligation that comes with enumeration is honesty about its edges: the
 * domain is derived from the policies under comparison, so a work type no policy
 * mentions is not probed. That is reported, not assumed away.
 */

export interface PolicyDelta {
  readonly target: PolicyTarget;
  readonly before: QuorumRequirement;
  readonly after: QuorumRequirement;
  /** Human-readable, one line per thing that moved. */
  readonly changes: readonly string[];
  /** Whether the change makes this target harder to pass. */
  readonly direction: 'stricter' | 'looser' | 'mixed';
}

export interface SimulationResult {
  /** Every probed target whose requirement moved. The counterexamples. */
  readonly deltas: readonly PolicyDelta[];
  /** How many targets were probed, so a "no differences" answer has a size. */
  readonly probed: number;
  /** Axis values the domain was built from — the edge of what was checked. */
  readonly domain: {
    readonly workTypes: readonly string[];
    readonly riskLevels: readonly string[];
    readonly paths: readonly string[];
  };
  /** True only when something was probed and nothing moved. */
  readonly identical: boolean;
}

/** Literal axis values the policies mention. `*` contributes nothing to probe. */
function axisValues(
  policies: readonly GatePolicySource[],
  pick: (policy: GatePolicySource) => readonly string[],
  fallback: string,
): string[] {
  const values = new Set<string>();
  for (const policy of policies) {
    for (const value of pick(policy)) if (value !== '*') values.add(value);
  }
  // A wildcard-only policy set still needs one probe, or the comparison would
  // report "no differences" having examined nothing — the most convincing
  // wrong answer available.
  if (values.size === 0) values.add(fallback);
  return [...values].sort();
}

function describe(before: QuorumRequirement, after: QuorumRequirement): string[] {
  const changes: string[] = [];
  const was = new Set(before.requiredRoles);
  const now = new Set(after.requiredRoles);

  for (const role of now) if (!was.has(role)) changes.push(`now requires "${role}"`);
  for (const role of was) if (!now.has(role)) changes.push(`no longer requires "${role}"`);
  if (before.minApprovals !== after.minApprovals) {
    changes.push(`approval floor ${String(before.minApprovals)} → ${String(after.minApprovals)}`);
  }
  const wasOverride = before.overridableBy.join(',');
  const nowOverride = after.overridableBy.join(',');
  if (wasOverride !== nowOverride) {
    changes.push(`override path [${wasOverride || 'none'}] → [${nowOverride || 'none'}]`);
  }
  const wasFrom = before.from.join(',');
  const nowFrom = after.from.join(',');
  if (wasFrom !== nowFrom) {
    changes.push(`matched by [${wasFrom || 'nothing'}] → [${nowFrom || 'nothing'}]`);
  }
  return changes;
}

function directionOf(
  before: QuorumRequirement,
  after: QuorumRequirement,
): PolicyDelta['direction'] {
  const was = new Set(before.requiredRoles);
  const now = new Set(after.requiredRoles);
  const added = [...now].some((role) => !was.has(role));
  const removed = [...was].some((role) => !now.has(role));

  const stricter =
    added ||
    after.minApprovals > before.minApprovals ||
    after.overridableBy.length < before.overridableBy.length;
  const looser =
    removed ||
    after.minApprovals < before.minApprovals ||
    after.overridableBy.length > before.overridableBy.length;

  if (stricter && looser) return 'mixed';
  return stricter ? 'stricter' : 'looser';
}

/**
 * Compares two policy sets and returns the concrete targets where they differ.
 *
 * Returns counterexamples, not a summary. A caller who wants "is this stricter"
 * can ask the deltas; a caller given only that answer cannot recover which card
 * it was about, and that is the question anybody reviewing a governance change
 * actually has.
 */
export function simulateGatePolicy(
  current: readonly GatePolicySource[],
  proposed: readonly GatePolicySource[],
): SimulationResult {
  const all = [...current, ...proposed];
  const workTypes = axisValues(all, (policy) => policy.applies_to.work_type, 'feature');
  const riskLevels = axisValues(all, (policy) => policy.applies_to.risk_level, 'low');
  // Path patterns are probed as themselves: a policy scoped to `packages/db/**`
  // is exercised by a path that matches it, which is the only way its row moves.
  const paths = axisValues(
    all,
    (policy) =>
      policy.applies_to.path_pattern.map((pattern) =>
        pattern.replace(/\*\*/g, 'x').replace(/\*/g, 'x'),
      ),
    'src/x.ts',
  );

  const deltas: PolicyDelta[] = [];
  let probed = 0;

  for (const workType of workTypes) {
    for (const riskLevel of riskLevels) {
      for (const path of paths) {
        probed += 1;
        const target: PolicyTarget = { workType, riskLevel, paths: [path] };
        const before = normaliseQuorum(matchPolicies(current, target));
        const after = normaliseQuorum(matchPolicies(proposed, target));
        const changes = describe(before, after);
        if (changes.length === 0) continue;
        deltas.push({ target, before, after, changes, direction: directionOf(before, after) });
      }
    }
  }

  return {
    deltas,
    probed,
    domain: { workTypes, riskLevels, paths },
    identical: probed > 0 && deltas.length === 0,
  };
}

export function formatSimulation(result: SimulationResult): string {
  const lines: string[] = [];

  if (result.identical) {
    lines.push(
      `No difference across ${String(result.probed)} probed target(s).`,
      '',
      'The count matters: "no differences" over an empty domain is not a result,',
      'and this says how much was actually checked.',
    );
  } else {
    const stricter = result.deltas.filter((delta) => delta.direction === 'stricter').length;
    const looser = result.deltas.filter((delta) => delta.direction === 'looser').length;
    lines.push(
      `${String(result.deltas.length)} of ${String(result.probed)} probed target(s) change — ` +
        `${String(stricter)} stricter, ${String(looser)} looser, ` +
        `${String(result.deltas.length - stricter - looser)} mixed`,
      '',
    );
    for (const delta of result.deltas) {
      lines.push(
        `  ${delta.direction === 'looser' ? '↓' : delta.direction === 'stricter' ? '↑' : '↕'} ` +
          `${delta.target.workType} / ${delta.target.riskLevel} / ${delta.target.paths[0] ?? '**'}`,
      );
      for (const change of delta.changes) lines.push(`      ${change}`);
    }
    if (looser > 0) {
      lines.push(
        '',
        'A loosening is the one that will not announce itself later: a rule that',
        'stops applying raises nothing, and the cards it stopped covering look',
        'exactly like cards it never covered.',
      );
    }
  }

  lines.push(
    '',
    `Domain probed: work types [${result.domain.workTypes.join(', ')}], ` +
      `risk levels [${result.domain.riskLevels.join(', ')}], ` +
      `${String(result.domain.paths.length)} path(s). Values no policy mentions were not probed.`,
  );
  return lines.join('\n');
}
