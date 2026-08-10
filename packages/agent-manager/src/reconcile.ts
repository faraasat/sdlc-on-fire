import type { RoleDefinition } from '@sdlc-on-fire/core';

/**
 * Reconciling specialist outputs (P1-AGENT-09, ADR-0059).
 *
 * The orchestrator is the single coordinator: it splits work, routes each piece,
 * and merges what comes back. Specialists never negotiate peer-to-peer, because
 * uncoordinated fan-out is the failure centralized coordination exists to
 * replace (papers/06).
 *
 * The rule that shapes this module is ADR-0059's last line: **a specialist's
 * claim is a proposal, not a merge-authorizing fact.** So reconciliation never
 * decides that a change is correct — it decides what is *coherent enough to
 * hand to the gate*. Two specialists editing the same file is a conflict a
 * merge cannot resolve by preferring the confident one, and a specialist
 * reporting its own tests green is a claim the daemon will re-run anyway.
 */

export interface SpecialistResult {
  readonly role: string;
  readonly filesChanged: readonly string[];
  readonly summary: string;
  /** What the specialist could not settle. Carried up, never dropped. */
  readonly openQuestions?: readonly string[] | undefined;
}

export interface Conflict {
  readonly kind: 'file-overlap' | 'out-of-scope' | 'unresolved-question';
  readonly detail: string;
  readonly roles: readonly string[];
}

export interface Reconciliation {
  readonly filesChanged: readonly string[];
  readonly conflicts: readonly Conflict[];
  /**
   * Whether the merged result may be handed to the gate.
   *
   * Not "whether the work is correct" — that is the gate's question, and this
   * function has no way to answer it. Coherence is what a merge can establish.
   */
  readonly coherent: boolean;
  readonly openQuestions: readonly string[];
}

/**
 * Merges specialist outputs and reports what does not line up.
 *
 * Pure, and deliberately unable to prefer one specialist over another. A merge
 * that broke ties by confidence would be letting the most assertive agent win,
 * which is the peer-to-peer negotiation ADR-0059 rules out wearing a different
 * hat.
 */
export function reconcile(
  results: readonly SpecialistResult[],
  roles: readonly RoleDefinition[] = [],
): Reconciliation {
  const conflicts: Conflict[] = [];
  const byFile = new Map<string, string[]>();

  for (const result of results) {
    for (const file of result.filesChanged) {
      byFile.set(file, [...(byFile.get(file) ?? []), result.role]);
    }
  }

  for (const [file, owners] of [...byFile.entries()].sort()) {
    if (owners.length > 1) {
      conflicts.push({
        kind: 'file-overlap',
        // Not resolvable here. Two edits to one file need the orchestrator to
        // re-dispatch with disjoint ownership, which is what ADR-0041 asks for.
        detail: `${file} was changed by ${owners.join(' and ')} — same-wave work must be disjoint`,
        roles: owners,
      });
    }
  }

  // A specialist writing outside its scope is not a merge conflict; it is a
  // role that did not stay in its lane, and it matters more, because the whole
  // basis for trusting a scoped specialist is the scope.
  const scopes = new Map(roles.map((role) => [role.key, role.contextScope]));
  for (const result of results) {
    const scope = scopes.get(result.role);
    if (scope === undefined || scope.length === 0) continue;
    const outside = result.filesChanged.filter(
      (file) => !scope.some((glob) => matches(glob, file)),
    );
    if (outside.length > 0) {
      conflicts.push({
        kind: 'out-of-scope',
        detail: `${result.role} changed ${outside.join(', ')}, outside its declared scope`,
        roles: [result.role],
      });
    }
  }

  const openQuestions = results.flatMap((result) => result.openQuestions ?? []);
  for (const question of openQuestions) {
    conflicts.push({
      kind: 'unresolved-question',
      // Merging over an open question is how a specialist's uncertainty
      // disappears into a summary and nobody sees it again.
      detail: question,
      roles: results
        .filter((result) => (result.openQuestions ?? []).includes(question))
        .map((result) => result.role),
    });
  }

  return {
    filesChanged: [...byFile.keys()].sort(),
    conflicts,
    coherent: conflicts.length === 0,
    openQuestions,
  };
}

/** Minimal glob matching — `**` and `*` only. Enough for path scopes, and no more. */
function matches(glob: string, file: string): boolean {
  const pattern = glob
    .split('**')
    .map((part) => part.split('*').map(escapeRegex).join('[^/]*'))
    .join('.*');
  return new RegExp(`^${pattern}$`).test(file);
}

function escapeRegex(text: string): string {
  return text.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}
