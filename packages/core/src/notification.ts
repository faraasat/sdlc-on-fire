/**
 * Notification tiers and @-mention fan-out (P4-COLLAB-02).
 *
 * Three tiers, and the reason there are three rather than one is that the cost
 * of being wrong is asymmetric in both directions. Interrupting somebody for a
 * comment nobody was waiting on trains them to mute the product; batching the
 * one thing that was actually blocking a release means the interruption never
 * arrives. So the tier is *derived* from the same `role_effect` that drives the
 * activity feed, never chosen by whoever wrote the comment.
 *
 * **Keyed off the stored effect, exactly as the feed is (ADR-0012).** A comment
 * typed `normal` whose resolved effect is `GATE_BLOCK` is instant, because the
 * effect is what the model computed from (type × role) at insert. Deriving
 * urgency from the comment's *type* here would be a second implementation of
 * the one value the comment model exists to make unambiguous, and the two would
 * disagree the first time a role's dispatch changed.
 *
 * **Fan-out resolves, it does not authorise.** `@security` expands to the
 * actors holding that role so they can be told; it grants nothing and checks
 * nothing. Whether any of them may act on what they were told is a capability
 * question answered elsewhere, and a reader arriving here looking for access
 * control must not mistake this for it.
 */

import { BLOCKING_EFFECTS, ATTENTION_EFFECTS } from './activity.js';
import { ROLE_KEYS, type RoleKey } from './capability.js';
import type { RoleEffect } from './comment-effect.js';

/** How urgently a notification is delivered. Derived, never authored. */
export const NOTIFICATION_TIERS = ['instant', 'batched', 'digest'] as const;
export type NotificationTier = (typeof NOTIFICATION_TIERS)[number];

/** A parsed `@…` reference, before it is resolved to people. */
export interface Mention {
  /** The text as written, without the `@`. */
  readonly handle: string;
  /** Roles are a closed vocabulary; anything else is treated as a user handle. */
  readonly kind: 'role' | 'user';
}

/**
 * Pull `@handles` out of a comment body.
 *
 * Deliberately conservative about what counts. An email address contains an `@`
 * and is not a mention, and a body quoting `foo@example.com` that paged the
 * `example` role would be both wrong and unexplainable to the person paged — so
 * a mention must be preceded by start-of-string or whitespace.
 *
 * Fenced code is stripped first. A comment pasting a stack trace or a shell
 * transcript containing `@qa` is not asking for QA, and being paged by
 * somebody's log output is the fastest way to make people stop reading
 * notifications.
 */
export function parseMentions(body: string): readonly Mention[] {
  const withoutCode = body.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ');

  const seen = new Set<string>();
  const mentions: Mention[] = [];
  for (const match of withoutCode.matchAll(/(?:^|\s)@([a-zA-Z0-9][a-zA-Z0-9._-]*)/g)) {
    const handle = match[1];
    if (handle === undefined) continue;
    const normalised = handle.toLowerCase();
    // Deduplicated: mentioning somebody three times in one comment is one
    // notification, not three.
    if (seen.has(normalised)) continue;
    seen.add(normalised);
    mentions.push({
      handle: normalised,
      kind: (ROLE_KEYS as readonly string[]).includes(normalised) ? 'role' : 'user',
    });
  }
  return mentions;
}

export interface TierInput {
  /** The resolved effect stored on the comment, or null for a non-comment event. */
  readonly effect?: RoleEffect | null;
  /** Whether this recipient was named — by handle or by their role. */
  readonly mentioned?: boolean;
  /** Whether the card is sitting on a stage that waits for a person. */
  readonly needsHuman?: boolean;
}

/**
 * Which tier an event reaches a given recipient in.
 *
 * Ordered by what a person cannot afford to miss rather than by what is loudest.
 * A blocking effect and a direct mention are both "somebody is waiting on you";
 * a card that has come to rest on a human-gated stage is "you will need to look
 * at this today"; everything else is a record, and a record belongs in a digest.
 */
export function tierFor(input: TierInput): NotificationTier {
  const effect = input.effect ?? null;
  if (effect !== null && BLOCKING_EFFECTS.includes(effect)) return 'instant';
  if (input.mentioned === true) return 'instant';
  if (input.needsHuman === true) return 'batched';
  if (effect !== null && ATTENTION_EFFECTS.includes(effect)) return 'batched';
  return 'digest';
}

/** Somebody who can be notified, and the roles they currently hold. */
export interface Recipient {
  readonly actorId: string;
  readonly handle: string;
  readonly roles: readonly RoleKey[];
}

export interface Notification {
  readonly actorId: string;
  readonly tier: NotificationTier;
  /** Why this person is being told — the mention that matched, or null for a broadcast. */
  readonly because: string;
}

export interface FanOutInput {
  readonly mentions: readonly Mention[];
  readonly recipients: readonly Recipient[];
  readonly effect?: RoleEffect | null;
  readonly needsHuman?: boolean;
  /** The comment's author, who is never notified about their own comment. */
  readonly authorActorId?: string | null;
}

/**
 * Turn mentions into notifications, one per person.
 *
 * A person named twice — by handle *and* by a role they hold — gets one
 * notification at the highest tier the event warrants, not two. Duplicate
 * delivery is the failure that makes people mute a channel, and it is easiest
 * to introduce exactly here, where two matching paths converge on one human.
 *
 * The author is excluded. Being notified of your own comment is noise with a
 * 100% false-positive rate.
 */
export function fanOut(input: FanOutInput): readonly Notification[] {
  const byActor = new Map<string, Notification>();

  for (const recipient of input.recipients) {
    if (recipient.actorId === input.authorActorId) continue;

    const matched = input.mentions.find(
      (mention) =>
        (mention.kind === 'user' && mention.handle === recipient.handle.toLowerCase()) ||
        (mention.kind === 'role' &&
          recipient.roles.some((role) => role === (mention.handle as RoleKey))),
    );
    if (matched === undefined) continue;

    const tier = tierFor({
      ...(input.effect === undefined ? {} : { effect: input.effect }),
      mentioned: true,
      ...(input.needsHuman === undefined ? {} : { needsHuman: input.needsHuman }),
    });
    const existing = byActor.get(recipient.actorId);
    if (existing === undefined || rank(tier) < rank(existing.tier)) {
      byActor.set(recipient.actorId, {
        actorId: recipient.actorId,
        tier,
        because: matched.kind === 'role' ? `@${matched.handle} (role)` : `@${matched.handle}`,
      });
    }
  }

  return [...byActor.values()].sort((a, b) => a.actorId.localeCompare(b.actorId));
}

/** Lower is more urgent. Used to keep the strongest reason when two paths match one person. */
function rank(tier: NotificationTier): number {
  return NOTIFICATION_TIERS.indexOf(tier);
}

/**
 * Whether a tier is delivered immediately or held.
 *
 * Split out because the delivery transport should not re-derive it. A transport
 * that decided for itself what "instant" meant would be a second policy, and
 * the two would diverge silently.
 */
export function isImmediate(tier: NotificationTier): boolean {
  return tier === 'instant';
}
