/**
 * `capability(actor, action, card)` — who may do what, and when (P3-RBAC-01,
 * ADR-0010, contract 01 §3.3).
 *
 * Postgres rows and one pure function, no RBAC library. ADR-0010 caps the model
 * at roughly eight roles on purpose: this is not ABAC, and a `roles` explosion
 * is a modeling error rather than a feature request. The whole decision is:
 *
 *     capability := (role_permission ∨ relationship_grant) ∧ ¬blocked_by_gate
 *
 * **The parenthesisation is load-bearing and the contract did not have it.**
 * The phase table wrote `role_permission ∨ relationship_grant ∧
 * ¬blocked_by_gate`, which under ordinary precedence means
 * `role_permission ∨ (relationship_grant ∧ ¬blocked_by_gate)` — a role
 * permission bypassing the gate entirely, with the gate constraining only
 * relationship grants. That is the difference between a gate and a suggestion,
 * and it is the reading a compiler picks. Resolved in contract 01 §3.3 before
 * this was written, not after.
 *
 * **The gate is the outer term** because a gate only ever blocks somebody who
 * could otherwise act. A rule where permission outranks a blocking gate blocks
 * nobody, which makes it not a rule.
 *
 * Three further properties, each one a way an access check quietly stops
 * checking:
 *
 * **A decision always carries its ground.** `granted` alone cannot distinguish
 * "the eng lead has this permission" from "nobody claimed otherwise", and an
 * audit six months later needs to know which. So every verdict names the
 * membership, grant or gate that produced it.
 *
 * **An expired membership is not a membership.** ADR-0035 added `expires_at` to
 * make grants time-bounded; a check that reads the row without reading the date
 * turns a temporary grant into a permanent one, and nothing looks wrong.
 *
 * **An agent is an actor, never an approver.** The structural disposer is a
 * database trigger on `approvals` (contract 01 §3.3) and this function does not
 * replace it. What it does is refuse to *report* a capability an agent could
 * not exercise, so the two layers agree rather than the UI offering a button
 * the database will refuse.
 */

/** The eight roles ADR-0010 caps the model at. */
export const ROLE_KEYS = [
  'eng-lead',
  'sr-eng',
  'designer',
  'pm',
  'qa',
  'security',
  'tech-writer',
  'stakeholder',
] as const;
export type RoleKey = (typeof ROLE_KEYS)[number];

/**
 * The action vocabulary — what a capability can be *for*.
 *
 * Every key here is an action the product already has a decision point for, and
 * nothing here is speculative: a permission nobody checks is a row that makes
 * the model look more complete than it is.
 */
export const PERMISSION_KEYS = [
  /** Move a work item to its next lifecycle stage. */
  'advance',
  /** Satisfy a role-gated gate. */
  'approve',
  /** Pass a gate whose evidence did not. Always leaves a reason (contract 01). */
  'override',
  /** Re-open a gate on completed work (P2-INS-02). */
  'reopen',
  /** Change committed scope — insertion into an in-flight initiative. */
  'rescope',
  /** Post a typed comment. */
  'comment',
  /** Take a work item as its owner. */
  'claim',
] as const;
export type PermissionKey = (typeof PERMISSION_KEYS)[number];

/**
 * Actions only a human may take (architecture §5: agents are actors, never
 * approvers).
 *
 * These are the four that *decide* rather than do. The structural disposer is
 * the `approvals` trigger; this list is what keeps the application layer from
 * offering an agent a button the database will refuse.
 */
export const HUMAN_ONLY_ACTIONS: readonly PermissionKey[] = [
  'approve',
  'override',
  'reopen',
  'rescope',
];

/**
 * The seed for `role_permissions`.
 *
 * Data, per ADR-0010 — the whole point of building this on rows is that the
 * policy is a table somebody can read, not an `if` chain. Two rows here are
 * pinned by other parts of the codebase and cross-checked in the tests rather
 * than merely written down:
 *
 * - `rescope` is held by exactly `RESCOPE_ROLES` (`insertion.ts`).
 * - `stakeholder` holds `comment` and nothing else, matching the comment
 *   dispatch's stakeholder row — "can be heard" and "can block" are different
 *   powers, and they have to be the same two roles in both tables.
 */
export const DEFAULT_ROLE_PERMISSIONS: Readonly<Record<RoleKey, readonly PermissionKey[]>> = {
  'eng-lead': ['advance', 'approve', 'override', 'reopen', 'rescope', 'comment', 'claim'],
  'sr-eng': ['advance', 'approve', 'comment', 'claim'],
  designer: ['approve', 'comment', 'claim'],
  pm: ['approve', 'rescope', 'comment'],
  qa: ['approve', 'reopen', 'comment', 'claim'],
  security: ['approve', 'reopen', 'override', 'comment'],
  'tech-writer': ['approve', 'comment', 'claim'],
  stakeholder: ['comment'],
};

/** How a capability was granted — or refused. Never a bare boolean. */
export const CAPABILITY_GROUNDS = [
  'role-permission',
  'relationship-grant',
  'blocked-by-gate',
  'no-grant',
  'agent-cannot-approve',
  'expired-membership',
] as const;
export type CapabilityGround = (typeof CAPABILITY_GROUNDS)[number];

export interface Actor {
  readonly id: string;
  readonly kind: 'human' | 'agent';
  readonly displayName: string;
  /**
   * Humans: bootstrapped from `git config user.email`, and the key the UI
   * resolves a browser session against (P3-UI-01). On the shared `Actor` rather
   * than on a second identity-only type, so that the actor an identity resolves
   * to is the same one {@link capability} takes — two Actor shapes would let
   * "who you are" and "what you may do" drift apart, which is the failure this
   * whole module exists to prevent.
   */
  readonly email?: string | null | undefined;
}

export interface Membership {
  readonly actorId: string;
  readonly roleKey: string;
  /** ADR-0035: time-bounded grants. Absent means indefinite. */
  readonly expiresAt?: string | undefined;
}

/**
 * A grant that comes from this actor's relationship to this card rather than
 * from a role — being its assignee, its author, or its reviewer.
 */
export interface RelationshipGrant {
  readonly actorId: string;
  readonly cardId: string;
  readonly action: string;
  readonly relationship: string;
  readonly expiresAt?: string | undefined;
}

/** A gate currently blocking action on a card. */
export interface BlockingGate {
  readonly cardId: string;
  readonly gate: string;
  /** Actions this gate blocks. Empty blocks everything on the card. */
  readonly blocks: readonly string[];
}

export interface CapabilityInput {
  readonly actor: Actor;
  readonly action: string;
  readonly cardId: string;
  readonly memberships: readonly Membership[];
  /** `role key → actions`, from `role_permissions` joined to `permissions`. */
  readonly rolePermissions: Readonly<Record<string, readonly string[]>>;
  readonly relationshipGrants?: readonly RelationshipGrant[] | undefined;
  readonly blockingGates?: readonly BlockingGate[] | undefined;
  /** Actions that only a human may take — approvals, per the invariant. */
  readonly humanOnlyActions?: readonly string[] | undefined;
  /** Evaluated against `expires_at`. A parameter, so a boundary is testable. */
  readonly now: string;
}

export interface CapabilityVerdict {
  readonly granted: boolean;
  readonly ground: CapabilityGround;
  /** The specific row that decided it — role key, relationship, or gate name. */
  readonly because: string;
}

const live = (expiresAt: string | undefined, now: string): boolean => {
  if (expiresAt === undefined) return true;
  const expiry = Date.parse(expiresAt);
  const at = Date.parse(now);
  // An unparseable expiry is treated as expired. A grant whose end date nobody
  // can read is not one anybody should be relying on.
  if (Number.isNaN(expiry) || Number.isNaN(at)) return false;
  return expiry > at;
};

/**
 * Whether an actor may take an action on a card.
 *
 * Pure, and every input is passed in rather than queried. The daemon does the
 * reading; this decides — which is what makes the decision reproducible from an
 * audit row six months later, when the memberships have changed.
 */
export function capability(input: CapabilityInput): CapabilityVerdict {
  const { actor, action, cardId, now } = input;

  // The invariant, checked before anything else. The structural disposer is a
  // database trigger; this exists so the two layers agree, rather than a UI
  // offering a button the database will refuse.
  if (actor.kind === 'agent' && (input.humanOnlyActions ?? []).includes(action)) {
    return {
      granted: false,
      ground: 'agent-cannot-approve',
      because: `"${action}" is human-only and ${actor.displayName} is an agent (architecture invariant: agents are actors, never approvers)`,
    };
  }

  const blocking = (input.blockingGates ?? []).filter(
    (gate) => gate.cardId === cardId && (gate.blocks.length === 0 || gate.blocks.includes(action)),
  );

  const mine = input.memberships.filter((membership) => membership.actorId === actor.id);
  const expired = mine.filter((membership) => !live(membership.expiresAt, now));
  const current = mine.filter((membership) => live(membership.expiresAt, now));

  const viaRole = current.find((membership) =>
    (input.rolePermissions[membership.roleKey] ?? []).includes(action),
  );

  const viaRelationship = (input.relationshipGrants ?? []).find(
    (grant) =>
      grant.actorId === actor.id &&
      grant.cardId === cardId &&
      grant.action === action &&
      live(grant.expiresAt, now),
  );

  if (viaRole === undefined && viaRelationship === undefined) {
    // An expired membership that *would* have granted this is reported as
    // expired rather than as absent: the two ask for different work, and
    // "you never had this" sends somebody to the wrong place.
    const lapsed = expired.find((membership) =>
      (input.rolePermissions[membership.roleKey] ?? []).includes(action),
    );
    return lapsed === undefined
      ? {
          granted: false,
          ground: 'no-grant',
          because: `no role or relationship grants "${action}" on ${cardId}`,
        }
      : {
          granted: false,
          ground: 'expired-membership',
          because: `${actor.displayName}'s "${lapsed.roleKey}" membership expired ${String(lapsed.expiresAt)} — a lapsed grant is not a grant (ADR-0035)`,
        };
  }

  // The outer term. Nothing a role grants outranks a blocking gate, because a
  // gate only ever blocks somebody who could otherwise act.
  const gate = blocking[0];
  if (gate !== undefined) {
    return {
      granted: false,
      ground: 'blocked-by-gate',
      because: `gate "${gate.gate}" is blocking ${cardId} — a permission that outranks a blocking gate blocks nobody`,
    };
  }

  return viaRole !== undefined
    ? {
        granted: true,
        ground: 'role-permission',
        because: `role "${viaRole.roleKey}" grants "${action}"`,
      }
    : {
        granted: true,
        ground: 'relationship-grant',
        because: `${actor.displayName} is ${viaRelationship?.relationship ?? 'related'} on ${cardId}`,
      };
}

/**
 * Structural problems with a role table, as lines.
 *
 * The cap is a design decision with a number on it, so it is checkable. A
 * registry that has grown past eight roles has stopped being the model ADR-0010
 * chose and become an ABAC system nobody decided to build.
 */
export function roleTableViolations(keys: readonly string[]): string[] {
  const violations: string[] = [];

  const unknown = keys.filter((key) => !(ROLE_KEYS as readonly string[]).includes(key));
  if (unknown.length > 0) {
    violations.push(
      `roles outside the capped set: ${unknown.join(', ')} — ADR-0010 caps this at ${String(ROLE_KEYS.length)} roles, and a row explosion is a modeling error rather than a feature request`,
    );
  }

  const duplicates = keys.filter((key, index) => keys.indexOf(key) !== index);
  if (duplicates.length > 0) {
    violations.push(`duplicate role key(s): ${[...new Set(duplicates)].join(', ')}`);
  }

  return violations;
}

export function formatCapability(input: CapabilityInput, verdict: CapabilityVerdict): string {
  return `${verdict.granted ? '✓' : '✗'} ${input.actor.displayName} may${verdict.granted ? '' : ' not'} "${input.action}" on ${input.cardId} — ${verdict.because}`;
}
