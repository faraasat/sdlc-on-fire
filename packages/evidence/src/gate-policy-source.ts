import { z } from 'zod';
import { GatePolicySchema, type GatePolicy } from './evaluate-gate.js';

/**
 * Gate policies as authored: YAML in `docs/gates/`, matched, then compiled
 * (P3-RBAC-03, ADR-0005, contract 03 §4, contract 06 §2).
 *
 * The source of truth is the file, not the row. `gate_policies` is the compiled
 * mirror — the same relationship `work_items` has to `kanban/` — so a policy
 * change is a diff somebody reviews rather than an UPDATE somebody ran.
 *
 * The part with teeth is **matching**. A card can match several policies, and
 * the question of which one applies is where a governance model quietly stops
 * governing. Contract 03 §4 fixes it as *first-matching-and-most-specific*,
 * with specificity counted as fewer wildcards — CODEOWNERS semantics, chosen
 * because it is the rule reviewers already have intuitions about. But matching
 * one policy and ignoring the rest would let a broad permissive policy shadow a
 * narrow strict one that also applies, so the *approvals* dimension does not
 * pick a winner at all: every matching policy's requirement is normalised
 * together (see `normaliseQuorum`). Specificity orders the list and decides the
 * evidence requirements; it never removes a required role somebody wrote down.
 */

const AppliesToSchema = z
  .object({
    work_type: z.array(z.string().min(1)).default(['*']),
    risk_level: z.array(z.string().min(1)).default(['*']),
    path_pattern: z.array(z.string().min(1)).default(['**']),
  })
  .prefault({});

/** A policy as it appears in a file, before compilation. */
export const GatePolicySourceSchema = GatePolicySchema.safeExtend({
  $schema: z.string().optional(),
  applies_to: AppliesToSchema,
  /** `"<from> -> <to>"` — the lifecycle edge this gates (ADR-0009). */
  transition: z.string().min(1).optional(),
});
export type GatePolicySource = z.infer<typeof GatePolicySourceSchema>;

export interface PolicyTarget {
  readonly workType: string;
  readonly riskLevel: string;
  /** Files the change touches, workspace-relative and posix-spelled. */
  readonly paths: readonly string[];
  readonly transition?: string | undefined;
}

/**
 * Matches a glob against a path, supporting `*` and `**` only.
 *
 * Deliberately small. A full glob engine here would be a dependency carrying
 * semantics nobody on this project has agreed to — and the field is documented
 * as CODEOWNERS-style, which is this subset.
 */
export function matchesGlob(pattern: string, target: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const expanded = escaped
    // `**/` may match nothing at all, so `**/x` matches a bare `x`.
    .replace(/\*\*\//g, '(?:.*/)?')
    .replace(/\*\*/g, '.*')
    // A single `*` stops at a separator.
    .replace(/(?<!\.)\*/g, '[^/]*');
  return new RegExp(`^${expanded}$`).test(target);
}

const matchesList = (values: readonly string[], candidate: string): boolean =>
  values.includes('*') || values.includes(candidate);

/**
 * How specific a policy is — fewer wildcards wins (contract 03 §4).
 *
 * Counted over all three axes so a policy pinning `work_type` beats one pinning
 * only a path depth. Ties keep file order, which is why the caller sorts
 * stably: two equally specific policies are a policy-set problem, and silently
 * picking one by name would hide it.
 */
export function specificity(policy: GatePolicySource): number {
  const wildcards =
    (policy.applies_to.work_type.includes('*') ? 1 : 0) +
    (policy.applies_to.risk_level.includes('*') ? 1 : 0) +
    policy.applies_to.path_pattern.filter((pattern) => pattern.includes('*')).length;
  return -wildcards;
}

export function matchesTarget(policy: GatePolicySource, target: PolicyTarget): boolean {
  if (
    policy.transition !== undefined &&
    target.transition !== undefined &&
    policy.transition.replace(/\s+/g, '') !== target.transition.replace(/\s+/g, '')
  ) {
    return false;
  }
  if (!matchesList(policy.applies_to.work_type, target.workType)) return false;
  if (!matchesList(policy.applies_to.risk_level, target.riskLevel)) return false;

  // A policy with no touched files to test against still applies — the change
  // set is unknown, not empty, and treating unknown as "matches nothing" would
  // silently drop every path-scoped policy on a card nobody has diffed yet.
  if (target.paths.length === 0) return true;
  return target.paths.some((file) =>
    policy.applies_to.path_pattern.some((pattern) => matchesGlob(pattern, file)),
  );
}

/**
 * Policies that apply to a target, most specific first.
 *
 * Returns **all** of them rather than the winner. The caller takes evidence
 * requirements from the first and normalises approvals across the set: a broad
 * permissive policy must not shadow a narrow strict one that also matched.
 */
export function matchPolicies(
  policies: readonly GatePolicySource[],
  target: PolicyTarget,
): GatePolicySource[] {
  return policies
    .filter((policy) => matchesTarget(policy, target))
    .map((policy, index) => ({ policy, index }))
    .sort((a, b) => specificity(b.policy) - specificity(a.policy) || a.index - b.index)
    .map((entry) => entry.policy);
}

export interface PolicyProblem {
  readonly file: string;
  readonly message: string;
}

export interface LoadedPolicies {
  readonly policies: readonly GatePolicySource[];
  readonly problems: readonly PolicyProblem[];
}

/**
 * Validates authored policy documents.
 *
 * A file that does not parse is a **problem**, never a skipped file. A gate
 * policy that fails to load is a gate that silently stops gating, and the
 * failure mode looks exactly like a card with no policy — which is the one
 * outcome an unparseable governance file must not produce.
 */
export function loadPolicies(
  documents: readonly { readonly file: string; readonly value: unknown }[],
): LoadedPolicies {
  const policies: GatePolicySource[] = [];
  const problems: PolicyProblem[] = [];
  const seen = new Map<string, string>();

  for (const document of documents) {
    const parsed = GatePolicySourceSchema.safeParse(document.value);
    if (!parsed.success) {
      problems.push({
        file: document.file,
        message: parsed.error.issues
          .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
          .join('; '),
      });
      continue;
    }

    const previous = seen.get(parsed.data.name);
    if (previous !== undefined) {
      // Two files claiming one name means `gates.policy_id` points at whichever
      // loaded last, and which one that is depends on directory order.
      problems.push({
        file: document.file,
        message: `policy name "${parsed.data.name}" is already defined by ${previous} — the name is what \`gates.policy_id\` resolves against`,
      });
      continue;
    }
    seen.set(parsed.data.name, document.file);
    policies.push(parsed.data);
  }

  return { policies, problems };
}

/** The compiled row form (contract 01 §3.4) — the mirror, not the source. */
export interface CompiledPolicyRow {
  readonly name: string;
  readonly workType: string | null;
  readonly riskLevel: string | null;
  readonly pathPattern: string | null;
  readonly requiredRole: string | null;
  readonly minApprovals: number;
  readonly overridableByRole: string | null;
}

/**
 * Compiles a policy into its row form.
 *
 * The row is lossy on purpose and the loss is worth naming: `gate_policies`
 * holds a single `required_role_id`, while a policy may name several. The rows
 * exist so the database can *join* — "which policies mention this role" — and
 * the authoritative multi-role requirement stays in the file. Compiling one row
 * per required role keeps that join honest rather than silently keeping the
 * first role and dropping the rest.
 */
export function compilePolicy(policy: GatePolicySource): CompiledPolicyRow[] {
  const base = {
    name: policy.name,
    workType: policy.applies_to.work_type.includes('*')
      ? null
      : (policy.applies_to.work_type[0] ?? null),
    riskLevel: policy.applies_to.risk_level.includes('*')
      ? null
      : (policy.applies_to.risk_level[0] ?? null),
    pathPattern: policy.applies_to.path_pattern[0] ?? null,
    minApprovals: policy.approvals.min_approvals,
    overridableByRole: policy.overridable_by[0] ?? null,
  };

  return policy.approvals.required_roles.length === 0
    ? [{ ...base, requiredRole: null }]
    : policy.approvals.required_roles.map((role) => ({ ...base, requiredRole: role }));
}

export function formatPolicyProblems(problems: readonly PolicyProblem[]): string {
  if (problems.length === 0) return '';
  return [
    `${String(problems.length)} gate policy file(s) did not load:`,
    ...problems.map((problem) => `  ✗ ${problem.file}: ${problem.message}`),
    '',
    'A policy that fails to load is a gate that silently stops gating, and that',
    'looks exactly like a card with no policy. Fix the file or delete it.',
  ].join('\n');
}

/** Re-exported so callers get the compiled type without a second import. */
export type { GatePolicy };
