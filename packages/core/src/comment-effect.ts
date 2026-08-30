import { z } from 'zod';
import { ROLE_KEYS } from './capability.js';

/**
 * The `(comment_type × author_role) → role_effect` dispatch (P1-CMT-02,
 * ADR-0012, ADR-0016).
 *
 * This is a security boundary wearing the clothes of a lookup table.
 *
 * A comment is human-authored text on a card. If anything downstream decided
 * what a comment *means* by reading its body, then anyone who can post a comment
 * can write one shaped like an authoritative instruction and have an agent act
 * on it. That is prompt injection with a UI.
 *
 * So the effect is computed **once, server-side, from the comment's type and its
 * author's role** — never from the body — and stored immutably on the row. Every
 * consumer keys off that enum. The body is content an agent may be *shown*; it
 * is never evidence of what the comment is for.
 *
 * The table is **data, not code** (ADR-0012): adding a comment type or a role is
 * an edit here, never an `if` chain somewhere downstream. And it is **total** —
 * every pair resolves, including the null-role case v0.1 actually runs in, so a
 * comment can never fall through to an undefined effect that some caller then
 * treats as permissive.
 */

export const COMMENT_TYPES = [
  'normal',
  'agent-instruction',
  'decision',
  'blocker',
  'bug-report',
  'review',
  'context-reference',
  /**
   * Design feedback that changes what "done" means (P6-SURFACE-08,
   * FEAT-CMT-008).
   *
   * An explicit type, because the alternative was worse in both directions:
   * `designer` + `normal` used to resolve to `UX_ACCEPTANCE_UPDATE`, which
   * meant a designer writing "looks great" mutated the acceptance criteria,
   * while a designer with no role could not raise a UX concern with any effect
   * at all. Intent belongs in the type the author picks, not in an inference
   * from who they are.
   */
  'ux-acceptance',
  /**
   * A scope change, said as one (P6-SURFACE-08, FEAT-CMT-009).
   *
   * Same correction as above, applied to `pm` + `decision`. Recording a
   * decision and changing the scope are different acts, and a PM does the
   * first far more often than the second — so reading every PM decision as a
   * rescope made the loud case out of the common one.
   */
  'rescope',
] as const;
export const CommentTypeSchema = z.enum(COMMENT_TYPES);
export type CommentType = z.infer<typeof CommentTypeSchema>;

/**
 * The ~8-role ceiling (ADR-0010) — the same list `capability()` and the `roles`
 * table use, not a second copy of it.
 *
 * It was a second copy, spelling two of the eight differently (`engineer` for
 * `sr-eng`, `product-manager` for `pm`). That cost nothing while `roles` was
 * unpopulated, and became a live defect the moment P3-RBAC-01 populated it:
 * `comments.author_role_id` resolves to a `roles.key`, so a comment from a real
 * `pm` would miss the `product-manager` row in the dispatch below and fall
 * through to the unroled default — turning a PM's `decision` from `RESCOPE`
 * into `DECISION_TO_MEMORY`, silently, with the table still looking correct.
 */
export const AUTHOR_ROLES = ROLE_KEYS;
export const AuthorRoleSchema = z.enum(AUTHOR_ROLES);
export type AuthorRole = z.infer<typeof AuthorRoleSchema>;

export const ROLE_EFFECTS = [
  'NONE',
  'GATE_BLOCK',
  'REQUIRED_CHANGE',
  'DECISION_TO_MEMORY',
  'RESCOPE',
  'UX_ACCEPTANCE_UPDATE',
  'CONTEXT_INJECTION',
  'BUG_CREATION',
] as const;
export const RoleEffectSchema = z.enum(ROLE_EFFECTS);
export type RoleEffect = z.infer<typeof RoleEffectSchema>;

/**
 * The effect a type resolves to when the author holds no role.
 *
 * v0.1's actual state: `roles` is created and unpopulated, so every real comment
 * arrives unroled. The row that matters is `normal` → `NONE`: an ordinary
 * comment from nobody in particular changes nothing, however it is phrased.
 *
 * `blocker` still blocks without a role, and that is deliberate. A solo operator
 * flagging a problem on their own card has no role to hold, and refusing them
 * the one effect that stops work would make the unroled case — the only case
 * v0.1 has — the one where nothing can be halted.
 */
const UNROLED: Readonly<Record<CommentType, RoleEffect>> = {
  normal: 'NONE',
  'agent-instruction': 'CONTEXT_INJECTION',
  decision: 'DECISION_TO_MEMORY',
  blocker: 'GATE_BLOCK',
  'bug-report': 'BUG_CREATION',
  review: 'REQUIRED_CHANGE',
  'context-reference': 'CONTEXT_INJECTION',
  'ux-acceptance': 'UX_ACCEPTANCE_UPDATE',
  rescope: 'RESCOPE',
};

/**
 * Where a role changes the answer, per `.research/05` §5.
 *
 * Only the differences are listed; everything else falls to {@link UNROLED}.
 * Spelling out all 56 pairs would make the *interesting* rows invisible.
 */
const BY_ROLE: Readonly<Partial<Record<AuthorRole, Partial<Record<CommentType, RoleEffect>>>>> = {
  // A stakeholder can post and be seen and cannot gate anything — the whole row,
  // not a subset, because "can be heard" and "can block" are different powers.
  stakeholder: {
    normal: 'NONE',
    'agent-instruction': 'NONE',
    decision: 'NONE',
    blocker: 'NONE',
    'bug-report': 'BUG_CREATION',
    review: 'NONE',
    'context-reference': 'NONE',
    'ux-acceptance': 'NONE',
    rescope: 'NONE',
  },
  security: { blocker: 'GATE_BLOCK' },
  'eng-lead': { review: 'REQUIRED_CHANGE' },
};

/**
 * Two rows that used to be here, and why they are not (P6-SURFACE-08).
 *
 * `designer: { normal: 'UX_ACCEPTANCE_UPDATE' }` and `pm: { decision:
 * 'RESCOPE' }` inferred a *strong* effect from an *ordinary* type on the
 * strength of who was speaking. Both were wrong in the same two ways: they
 * fired on the common case (a designer's plain remark; a PM recording a
 * decision) and they gave the deliberate case no way to be said at all by
 * anyone without the role. The explicit `ux-acceptance` and `rescope` types
 * replace them — intent stated by the author, not inferred from their badge.
 *
 * **Which roles may rescope is deliberately not encoded here.** That is
 * approval policy, and it belongs in the gate policies where it can be scoped
 * by work type, risk and path — not hard-coded into a lookup table that every
 * workspace shares. What this table still enforces is the one rule that is not
 * policy: a `stakeholder` can be heard and cannot gate.
 */

/**
 * Resolves a comment's effect.
 *
 * Takes the type and the role. It does not take the body, and that is the
 * point — the signature is where the injection defence is enforced, because a
 * caller cannot pass text that was never a parameter.
 */
export function roleEffectFor(type: CommentType, role: AuthorRole | null): RoleEffect {
  if (role === null) return UNROLED[type];
  return BY_ROLE[role]?.[type] ?? UNROLED[type];
}

/** Every pair the table resolves, for auditing it as the data it is. */
export function dispatchTable(): readonly {
  type: CommentType;
  role: AuthorRole | null;
  effect: RoleEffect;
}[] {
  const rows: { type: CommentType; role: AuthorRole | null; effect: RoleEffect }[] = [];
  for (const type of COMMENT_TYPES) {
    rows.push({ type, role: null, effect: roleEffectFor(type, null) });
    for (const role of AUTHOR_ROLES) rows.push({ type, role, effect: roleEffectFor(type, role) });
  }
  return rows;
}

/** Effects whose comments may contribute text to a context pack. */
export const CONTEXT_BEARING_EFFECTS: readonly RoleEffect[] = [
  'CONTEXT_INJECTION',
  'DECISION_TO_MEMORY',
];

export const CommentSchema = z
  .object({
    id: z.number().int().nonnegative(),
    workItemId: z.string().min(1),
    type: CommentTypeSchema,
    authorRole: AuthorRoleSchema.nullable().default(null),
    body: z.string(),
    /**
     * Computed at insert and immutable (ADR-0012).
     *
     * Carried on the row rather than recomputed by readers: a reader that
     * recomputes is a reader that can be given different inputs, and the value
     * of deciding once server-side is that there is only one decision.
     */
    roleEffect: RoleEffectSchema,
    /** Optional narrowing — an instruction meant for one agent or role. */
    addressedTo: z.string().nullable().default(null),
    createdAt: z.iso.datetime(),
  })
  .strict();

export type Comment = z.infer<typeof CommentSchema>;
