/**
 * Who is using the UI (P3-UI-01).
 *
 * The daemon has always known which actor an agent is, because an agent is
 * launched with one. A browser tab is not launched with anything, so identity
 * has to be *resolved*, and the resolution has a property that matters more
 * than convenience: an actor decides what a person is permitted to do
 * (P3-RBAC-01), and getting it wrong in the permissive direction hands somebody
 * else's approval rights to whoever opened the page.
 *
 * Hence the shape here. Every path returns a ground — how the actor was
 * decided — and the ground is carried through to the caller rather than
 * flattened into "logged in". A UI that cannot say *why* it thinks you are the
 * engineering lead should not be acting as one.
 */

// The domain `Actor`, not a second identity-only shape. An identity resolves to
// the actor `capability()` consumes, so "who you are" and "what you may do"
// cannot drift apart.
import type { Actor } from './capability.js';

export type { Actor };

/** How an identity was arrived at. Ordered from strongest to weakest. */
export const IDENTITY_GROUNDS = ['token', 'git-email', 'solo-implicit', 'none'] as const;
export type IdentityGround = (typeof IDENTITY_GROUNDS)[number];

export interface ResolvedIdentity {
  readonly actor: Actor | null;
  readonly ground: IdentityGround;
  readonly because: string;
  /**
   * Whether this identity may be used for anything a human signs off on.
   *
   * Separate from `actor !== null` on purpose. Solo mode resolves an actor and
   * still must not be treated as proof of who is at the keyboard.
   */
  readonly attributable: boolean;
}

export interface ResolveIdentityInput {
  /** Per-project token, if the browser presented one. The only strong path. */
  readonly token?: string | undefined;
  /** Actor id a valid token maps to. */
  readonly tokenActorId?: string | undefined;
  /** `git config user.email` from the workspace. */
  readonly gitEmail?: string | undefined;
  readonly actors: readonly Actor[];
}

/**
 * Resolve the human behind a UI session.
 *
 * The solo-mode fallback is deliberate and deliberately limited. A single
 * developer running this on their own machine should not have to configure an
 * identity to see their own board — that friction is the top abandonment risk
 * this project has written down. But "there is only one human here, so you must
 * be them" is an inference about an empty room, not a fact about a person, and
 * it collapses the moment a second human exists. So it resolves an actor, marks
 * `attributable: false`, and the approval paths refuse it.
 */
export function resolveIdentity(input: ResolveIdentityInput): ResolvedIdentity {
  const humans = input.actors.filter((actor) => actor.kind === 'human');

  if (input.token !== undefined && input.token.length > 0) {
    const matched = input.actors.find((actor) => actor.id === input.tokenActorId);
    if (matched !== undefined) {
      return {
        actor: matched,
        ground: 'token',
        because: 'a per-project token identified this actor',
        attributable: true,
      };
    }
    // A token that resolves to nobody is not a reason to fall through to a
    // weaker path — it is a reason to stop. Falling through would let an
    // invalid token quietly become solo mode, which is an upgrade in access
    // won by presenting a bad credential.
    return {
      actor: null,
      ground: 'none',
      because: 'the token presented does not map to a known actor',
      attributable: false,
    };
  }

  if (input.gitEmail !== undefined && input.gitEmail.length > 0) {
    const email = input.gitEmail.trim().toLowerCase();
    const matched = humans.filter((actor) => (actor.email ?? '').trim().toLowerCase() === email);
    if (matched.length === 1) {
      return {
        actor: matched[0] ?? null,
        ground: 'git-email',
        because: `git config user.email matched ${input.gitEmail}`,
        attributable: true,
      };
    }
    if (matched.length > 1) {
      // Two actors sharing an email is a data problem, and picking one would
      // hide it behind a plausible answer.
      return {
        actor: null,
        ground: 'none',
        because: `${String(matched.length)} actors share the email ${input.gitEmail}`,
        attributable: false,
      };
    }
  }

  if (humans.length === 1) {
    return {
      actor: humans[0] ?? null,
      ground: 'solo-implicit',
      because:
        'exactly one human actor exists, so this is solo mode — enough to read the board, ' +
        'not enough to attribute an approval to a person',
      attributable: false,
    };
  }

  return {
    actor: null,
    ground: 'none',
    because:
      humans.length === 0
        ? 'no human actors exist yet — run `sdlc init` or add one'
        : `${String(humans.length)} human actors exist and nothing identified which one this is`,
    attributable: false,
  };
}

/**
 * Whether an identity may take an action that a human must own.
 *
 * The gate is `attributable`, never `actor !== null`. Solo mode has an actor
 * and must still be refused here: an approval recorded against a guess is
 * exactly the kind of evidence this product exists to reject.
 */
export function canAttribute(identity: ResolvedIdentity): boolean {
  return identity.attributable && identity.actor !== null && identity.actor.kind === 'human';
}
