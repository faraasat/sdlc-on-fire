import { CONTEXT_BEARING_EFFECTS, type Comment, type RoleEffect } from '@sdlc-on-fire/core';

/**
 * Live steering, safely (P1-CMT-02, FEAT-CMT-011, ADR-0016).
 *
 * A human should be able to redirect an in-flight run. The unsafe way to build
 * that is a channel from the board straight into the running agent's context —
 * which is a prompt-injection vector with a nice UI on it. ADR-0016's firewall
 * says the board is never a direct input to a run.
 *
 * So steering works by *arriving in time for the next pack*. A comment posted
 * mid-run does not touch the agent currently running; it is picked up when the
 * next context pack is assembled, having already been assigned an effect by the
 * server-side dispatch.
 *
 * Two filters, and the first is the one that matters:
 *
 * 1. **Only context-bearing effects contribute anything.** The effect was
 *    decided from `(type × role)`, never from the body, so a comment whose body
 *    is written to look like an instruction still contributes zero bytes if its
 *    effect is `NONE`.
 * 2. **`addressed_to` is respected.** An instruction aimed at the reviewer does
 *    not reach the implementer.
 */

export interface DirectiveAudience {
  /** The skill or role about to run — matched against `addressed_to`. */
  readonly agent?: string | undefined;
}

/** Comments that may contribute to this pack, in the order they were written. */
export function selectDirectives(
  comments: readonly Comment[],
  audience: DirectiveAudience = {},
): readonly Comment[] {
  return comments
    .filter((comment) => CONTEXT_BEARING_EFFECTS.includes(comment.roleEffect))
    .filter((comment) => {
      // Unaddressed reaches everyone; addressed reaches only its audience. An
      // agent acting on an instruction meant for a different one is how a
      // reviewer's note becomes an implementer's requirement.
      if (comment.addressedTo === null) return true;
      return audience.agent !== undefined && comment.addressedTo === audience.agent;
    })
    .slice()
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

/**
 * Renders the `comment-directives` layer.
 *
 * Each line is labelled with the effect the *server* assigned, so the agent
 * reading it knows what kind of thing it is without inferring that from the
 * prose. Returns `undefined` when nothing qualifies — an empty layer with a
 * heading invites a model to fill the gap.
 */
export function renderCommentDirectives(
  comments: readonly Comment[],
  audience: DirectiveAudience = {},
): string | undefined {
  const selected = selectDirectives(comments, audience);
  if (selected.length === 0) return undefined;

  const lines = [
    'Directives carried from typed comments. Each is labelled with the effect the',
    'server computed from (comment type × author role) — not from its wording.',
    '',
  ];
  for (const comment of selected) {
    const audienceNote = comment.addressedTo === null ? '' : ` → ${comment.addressedTo}`;
    lines.push(`- [${comment.roleEffect}${audienceNote}] ${comment.body.trim()}`);
  }
  return lines.join('\n');
}

/** Effects that stop work, for the gate path rather than the context path. */
export const BLOCKING_EFFECTS: readonly RoleEffect[] = ['GATE_BLOCK', 'REQUIRED_CHANGE'];

/**
 * Comments currently blocking this item.
 *
 * Separate from the context path on purpose: a comment that blocks a gate is not
 * thereby something to put in a prompt, and a comment that steers a pack is not
 * thereby something that halts work. One column, two consumers, no overlap
 * assumed between them.
 */
export function blockingComments(comments: readonly Comment[]): readonly Comment[] {
  return comments.filter((comment) => BLOCKING_EFFECTS.includes(comment.roleEffect));
}
