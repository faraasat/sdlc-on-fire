import { describe, expect, it } from 'vitest';
import {
  compilePolicy,
  formatPolicyProblems,
  GatePolicySourceSchema,
  loadPolicies,
  matchesGlob,
  matchPolicies,
  matchesTarget,
  specificity,
  type GatePolicySource,
  type PolicyTarget,
} from './gate-policy-source.js';
import { normaliseQuorum } from './quorum.js';

/** P3-RBAC-03 — authored policies, matching, and the compiled mirror. */

const source = (over: Record<string, unknown> = {}): GatePolicySource =>
  GatePolicySourceSchema.parse({ name: 'p', ...over });

const target = (over: Partial<PolicyTarget> = {}): PolicyTarget => ({
  workType: 'feature',
  riskLevel: 'low',
  paths: ['src/app.ts'],
  ...over,
});

describe('globs', () => {
  it('matches ** across separators', () => {
    expect(matchesGlob('**', 'a/b/c.ts')).toBe(true);
    expect(matchesGlob('src/**', 'src/a/b.ts')).toBe(true);
  });

  it('stops a single * at a separator', () => {
    // Otherwise `src/*.ts` silently covers the whole tree, and a policy scoped
    // to one directory quietly governs every file under it.
    expect(matchesGlob('src/*.ts', 'src/a.ts')).toBe(true);
    expect(matchesGlob('src/*.ts', 'src/deep/a.ts')).toBe(false);
  });

  it('lets **/ match nothing at all', () => {
    expect(matchesGlob('**/schema.ts', 'schema.ts')).toBe(true);
    expect(matchesGlob('**/schema.ts', 'packages/db/schema.ts')).toBe(true);
  });

  it('treats dots literally', () => {
    expect(matchesGlob('a.ts', 'axts')).toBe(false);
  });
});

describe('matching', () => {
  it('matches a wildcard work type', () => {
    expect(matchesTarget(source(), target())).toBe(true);
  });

  it('refuses a work type the policy does not name', () => {
    expect(
      matchesTarget(
        source({ applies_to: { work_type: ['bug'] } }),
        target({ workType: 'feature' }),
      ),
    ).toBe(false);
  });

  it('refuses a risk level the policy does not name', () => {
    expect(
      matchesTarget(source({ applies_to: { risk_level: ['high'] } }), target({ riskLevel: 'low' })),
    ).toBe(false);
  });

  it('refuses when no touched file matches the path pattern', () => {
    expect(
      matchesTarget(
        source({ applies_to: { path_pattern: ['packages/db/**'] } }),
        target({ paths: ['README.md'] }),
      ),
    ).toBe(false);
  });

  it('applies when the change set is unknown rather than empty', () => {
    // Unknown is not "matches nothing". Treating it that way would drop every
    // path-scoped policy on a card nobody has diffed yet — silently.
    expect(
      matchesTarget(
        source({ applies_to: { path_pattern: ['packages/db/**'] } }),
        target({ paths: [] }),
      ),
    ).toBe(true);
  });

  it('respects the transition when both sides name one', () => {
    expect(
      matchesTarget(
        source({ transition: 'build -> review' }),
        target({ transition: 'build->review' }),
      ),
    ).toBe(true);
    expect(
      matchesTarget(
        source({ transition: 'review -> done' }),
        target({ transition: 'build -> review' }),
      ),
    ).toBe(false);
  });
});

describe('specificity', () => {
  it('ranks a fully pinned policy above a wildcard one', () => {
    const narrow = source({
      name: 'narrow',
      applies_to: {
        work_type: ['feature'],
        risk_level: ['high'],
        path_pattern: ['packages/db/x.ts'],
      },
    });
    expect(specificity(narrow)).toBeGreaterThan(specificity(source({ name: 'broad' })));
  });

  it('orders matches most specific first', () => {
    const matched = matchPolicies(
      [
        source({ name: 'broad' }),
        source({
          name: 'narrow',
          applies_to: { work_type: ['feature'], risk_level: ['low'], path_pattern: ['src/app.ts'] },
        }),
      ],
      target(),
    );
    expect(matched.map((policy) => policy.name)).toEqual(['narrow', 'broad']);
  });

  it('keeps file order for equally specific policies', () => {
    // Two equally specific matches are a policy-set problem; picking one by
    // name would hide it behind a stable-looking answer.
    const matched = matchPolicies([source({ name: 'a' }), source({ name: 'b' })], target());
    expect(matched.map((policy) => policy.name)).toEqual(['a', 'b']);
  });

  it('returns every match, so a broad policy cannot shadow a strict one', () => {
    // The reason matching returns a list rather than a winner. The requirement
    // sits on the *broad* policy deliberately: the narrow one
    // sorts first, so a "first match wins" implementation would keep the strict
    // policy and drop the security review — and still look right.
    const matched = matchPolicies(
      [
        source({ name: 'broad', approvals: { required_roles: ['security'], min_approvals: 1 } }),
        source({
          name: 'narrow',
          applies_to: { work_type: ['feature'], risk_level: ['low'], path_pattern: ['src/app.ts'] },
          approvals: { required_roles: ['qa'], min_approvals: 1 },
        }),
      ],
      target(),
    );
    expect(normaliseQuorum(matched).requiredRoles).toEqual(['qa', 'security']);
  });
});

describe('loading', () => {
  it('reports an unparseable file rather than skipping it', () => {
    // A gate policy that fails to load is a gate that stops gating, and the
    // symptom is identical to a card with no policy at all.
    const loaded = loadPolicies([{ file: 'docs/gates/bad.yaml', value: { approvals: 3 } }]);
    expect(loaded.policies).toHaveLength(0);
    expect(loaded.problems[0]?.file).toBe('docs/gates/bad.yaml');
  });

  it('refuses two files claiming one policy name', () => {
    const loaded = loadPolicies([
      { file: 'a.yaml', value: { name: 'standard' } },
      { file: 'b.yaml', value: { name: 'standard' } },
    ]);
    expect(loaded.policies).toHaveLength(1);
    expect(loaded.problems[0]?.message).toContain('already defined by a.yaml');
  });

  it('keeps the good files when one is broken', () => {
    const loaded = loadPolicies([
      { file: 'good.yaml', value: { name: 'good' } },
      { file: 'bad.yaml', value: { name: '' } },
    ]);
    expect(loaded.policies.map((policy) => policy.name)).toEqual(['good']);
    expect(loaded.problems).toHaveLength(1);
  });

  it('says why loading matters when it prints', () => {
    expect(formatPolicyProblems(loadPolicies([{ file: 'x', value: 1 }]).problems)).toContain(
      'silently stops gating',
    );
  });

  it('prints nothing when nothing is wrong', () => {
    expect(formatPolicyProblems([])).toBe('');
  });
});

describe('compiling to rows', () => {
  it('emits one row per required role rather than keeping the first', () => {
    // `gate_policies` holds a single `required_role_id`. Compiling only the
    // first role would make "which policies require security" answer no.
    const rows = compilePolicy(
      source({ approvals: { required_roles: ['eng-lead', 'security'], min_approvals: 1 } }),
    );
    expect(rows.map((row) => row.requiredRole)).toEqual(['eng-lead', 'security']);
    expect(rows.every((row) => row.minApprovals === 1)).toBe(true);
  });

  it('emits one row with no role when the policy names none', () => {
    const rows = compilePolicy(source());
    expect(rows).toHaveLength(1);
    expect(rows[0]?.requiredRole).toBeNull();
  });

  it('stores a wildcard axis as NULL rather than the literal star', () => {
    // NULL is what the column means by "any"; a literal `*` would only ever
    // match a work item whose type is the string `*`.
    const rows = compilePolicy(source());
    expect(rows[0]?.workType).toBeNull();
    expect(rows[0]?.riskLevel).toBeNull();
  });

  it('keeps a pinned axis', () => {
    const rows = compilePolicy(
      source({ applies_to: { work_type: ['bug'], risk_level: ['high'] } }),
    );
    expect(rows[0]?.workType).toBe('bug');
    expect(rows[0]?.riskLevel).toBe('high');
  });
});
