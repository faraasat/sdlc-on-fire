/**
 * Where a context segment is allowed to come from (P3-UI-02, ADR-0016).
 *
 * The firewall in one sentence: **a human's intent reaches an agent only after
 * being persisted through the daemon**, where it acquires an author, a
 * timestamp and a row somebody can point at. Never straight out of a browser.
 *
 * The reason is not tidiness. Everything an agent acts on in this product is
 * supposed to be attributable and reconstructible — that is what makes evidence
 * evidence. A value typed into a filter box has no author, no timestamp and no
 * durable record; if it reached a context pack, the agent would be acting on
 * something that cannot be traced, cannot be reviewed, and vanishes when the
 * tab closes. The pack would still look complete.
 *
 * ADR-0016 states this as a rule. A rule that nothing checks is a comment, so
 * this is the deterministic disposer for it: every segment carries an origin,
 * and an origin outside the allowlist is refused by a comparison rather than by
 * anybody remembering the ADR.
 */

import type { ContextLayerKind } from './context.js';

/**
 * Origins that may enter a context pack.
 *
 * All of them share one property: the content already exists in git or in a
 * daemon-written table before it is read here, so it has an author and can be
 * reconstructed after the fact.
 */
export const CONTEXT_ORIGINS = [
  /** The work item's own Markdown — source of truth, in git. */
  'card',
  /** A doc from the mirrored docs tree. */
  'doc',
  /** A comment: authored, attributed, and persisted with a role effect. */
  'comment',
  /** Typed memory written by the daemon. */
  'memory',
  /** Retrieval over the above. Never a new source — a view of existing ones. */
  'retrieval',
  /** Compiled skill instructions, from the canonical skills stage. */
  'skill',
  /** Rolling state, summarised and written by the daemon. */
  'rolling-state',
  /** Evidence envelopes — the whole point of the product. */
  'evidence',
] as const;

export type ContextOrigin = (typeof CONTEXT_ORIGINS)[number];

/**
 * Origins that are named and refused, rather than merely absent.
 *
 * Naming them buys a real message. A segment tagged `ui-filter` gets told what
 * is wrong and what to do instead — persist it as a comment — where an unknown
 * origin can only be reported as unknown.
 */
export const UI_ORIGINS = [
  'ui-state',
  'ui-filter',
  'ui-selection',
  'ui-draft',
  'ui-presence',
  'ui-view',
] as const;

export type UiOrigin = (typeof UI_ORIGINS)[number];

export type ProvenanceRefusal = 'ui-state' | 'unknown-origin' | 'no-origin';

export interface ProvenanceVerdict {
  readonly admitted: boolean;
  readonly refusal?: ProvenanceRefusal;
  readonly because: string;
}

export function isContextOrigin(origin: string): origin is ContextOrigin {
  return (CONTEXT_ORIGINS as readonly string[]).includes(origin);
}

export function isUiOrigin(origin: string): origin is UiOrigin {
  return (UI_ORIGINS as readonly string[]).includes(origin);
}

/**
 * Whether a segment with this origin may enter a context pack.
 *
 * An absent origin is refused, not defaulted. Defaulting to an allowed value
 * would mean the check passes for exactly the segments nobody thought about —
 * which is where a leak would come from.
 */
export function admitContextOrigin(origin: string | undefined | null): ProvenanceVerdict {
  if (origin === undefined || origin === null || origin.trim() === '') {
    return {
      admitted: false,
      refusal: 'no-origin',
      because: 'a segment with no declared origin cannot be shown to be attributable',
    };
  }

  const normalised = origin.trim();

  if (isUiOrigin(normalised)) {
    return {
      admitted: false,
      refusal: 'ui-state',
      because:
        `${normalised} is browser-held UI state: no author, no timestamp, gone when the tab ` +
        'closes. Persist it as a comment or a card edit and it becomes context legitimately',
    };
  }

  if (!isContextOrigin(normalised)) {
    return {
      admitted: false,
      refusal: 'unknown-origin',
      because: `${normalised} is not a known context origin`,
    };
  }

  return { admitted: true, because: `${normalised} is persisted and attributable` };
}

export interface ProvenancedSegment {
  readonly origin: string;
  /** Where in the pack it sits — used only to make a violation locatable. */
  readonly label?: string;
}

export interface ProvenanceViolation {
  readonly label: string;
  readonly origin: string;
  readonly refusal: ProvenanceRefusal;
  readonly because: string;
}

/**
 * Check a whole pack's provenance.
 *
 * Returns every violation rather than the first. A pack assembled from six
 * sources with two leaks should report two, or fixing one makes the next
 * appear and the problem looks like whack-a-mole instead of a list.
 */
export function checkPackProvenance(
  segments: readonly ProvenancedSegment[],
): readonly ProvenanceViolation[] {
  const violations: ProvenanceViolation[] = [];
  for (const [index, segment] of segments.entries()) {
    const verdict = admitContextOrigin(segment.origin);
    if (!verdict.admitted && verdict.refusal !== undefined) {
      violations.push({
        label: segment.label ?? `segment ${String(index)}`,
        origin: segment.origin,
        refusal: verdict.refusal,
        because: verdict.because,
      });
    }
  }
  return violations;
}

/**
 * Where each context layer comes from (P3-UI-02).
 *
 * Total over `CONTEXT_LAYER_KINDS`, and that totality is the enforcement.
 * Adding a layer to a context pack without saying where it comes from is a type
 * error at the moment the layer is declared — not a runtime check somebody has
 * to remember to call, and not a review comment.
 */
export const LAYER_ORIGIN: Record<ContextLayerKind, ContextOrigin> = {
  'skill-stable': 'skill',
  'rolling-state': 'rolling-state',
  'card-core': 'card',
  'comment-directives': 'comment',
  retrieval: 'retrieval',
};

/**
 * Every layer of an assembled pack, checked.
 *
 * Called by `assembleContextPack` on the way out. Cheap — a handful of string
 * comparisons — and it converts ADR-0016 from a rule into a thing that fails.
 */
export function checkLayerProvenance(
  kinds: readonly ContextLayerKind[],
): readonly ProvenanceViolation[] {
  return checkPackProvenance(
    kinds.map((kind) => ({ origin: LAYER_ORIGIN[kind] ?? '', label: kind })),
  );
}
