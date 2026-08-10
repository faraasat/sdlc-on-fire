import { z } from 'zod';

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
] as const;
export const CommentTypeSchema = z.enum(COMMENT_TYPES);
export type CommentType = z.infer<typeof CommentTypeSchema>;

/** The ~8-role ceiling (ADR-0010). Unpopulated in v0.1; the dispatch handles that. */
export const AUTHOR_ROLES = [
  'eng-lead',
  'engineer',
  'designer',
  'product-manager',
  'qa',
  'security',
  'tech-writer',
  'stakeholder',
] as const;
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
  },
  designer: { normal: 'UX_ACCEPTANCE_UPDATE' },
  'product-manager': { decision: 'RESCOPE' },
  security: { blocker: 'GATE_BLOCK' },
  'eng-lead': { review: 'REQUIRED_CHANGE' },
};

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
