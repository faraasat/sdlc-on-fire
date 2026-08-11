/**
 * Per-tool-surface threat modelling (P2-SEC-06, FEAT-SEC-009, ADR-0027).
 *
 * **Why this is a checklist and a gate rather than a skill.** The obvious build
 * is a `threat-model` agent skill: hand a model the diff, ask what could go
 * wrong, record the answer. That fails the test this product applies to every
 * decision path — *what is the deterministic disposer?* A model asked to
 * enumerate threats will produce a plausible list, a different plausible list
 * tomorrow, and no signal at all about what it failed to consider. Silence
 * would be indistinguishable from safety.
 *
 * So the enumeration is fixed and the gate is on **coverage, not content**.
 * MAESTRO supplies the agentic-system layers to walk; STRIDE supplies the
 * per-component categories. Every (component × category) cell needs an explicit
 * disposition — mitigated, accepted, or not-applicable *with a reason*. A model
 * may draft every one of those answers. It cannot skip a cell, and it cannot
 * make an unanswered cell look answered, because the checker counts cells.
 *
 * "Accepted" is a first-class outcome on purpose. A threat model where
 * everything must be mitigated is one people fill in dishonestly; recording
 * that a risk was seen and knowingly taken is more useful than a form that says
 * every box is green.
 */

/** STRIDE, per component. */
export const STRIDE_CATEGORIES = [
  'spoofing',
  'tampering',
  'repudiation',
  'information-disclosure',
  'denial-of-service',
  'elevation-of-privilege',
] as const;

export type StrideCategory = (typeof STRIDE_CATEGORIES)[number];

/**
 * MAESTRO's layers, as they apply to an agentic tool surface.
 *
 * Kept because the STRIDE grid alone was written for classical systems and has
 * no cell for "the model was talked into it" — which is the failure mode this
 * product spends most of its security budget on.
 */
export const MAESTRO_LAYERS = [
  'foundation-model',
  'data-operations',
  'agent-frameworks',
  'deployment-infrastructure',
  'evaluation-observability',
  'security-compliance',
  'agent-ecosystem',
] as const;

export type MaestroLayer = (typeof MAESTRO_LAYERS)[number];

export const DISPOSITIONS = ['mitigated', 'accepted', 'not-applicable'] as const;
export type Disposition = (typeof DISPOSITIONS)[number];

export interface ThreatEntry {
  readonly component: string;
  readonly category: StrideCategory;
  readonly disposition: Disposition;
  /** Required for every disposition — including `not-applicable`. */
  readonly rationale: string;
}

export interface ToolSurface {
  readonly name: string;
  /** The MAESTRO layers this surface touches. */
  readonly layers: readonly MaestroLayer[];
  /** Trust-boundary-crossing components. One row of the grid each. */
  readonly components: readonly string[];
}

export interface ThreatModelGap {
  readonly component: string;
  readonly category: StrideCategory;
  readonly reason: string;
}

export interface ThreatModelResult {
  readonly surface: string;
  readonly required: number;
  readonly answered: number;
  readonly gaps: readonly ThreatModelGap[];
  readonly accepted: readonly ThreatEntry[];
  readonly complete: boolean;
}

/** Every cell the grid demands. */
export function requiredCells(surface: ToolSurface): readonly ThreatModelGap[] {
  return surface.components.flatMap((component) =>
    STRIDE_CATEGORIES.map((category) => ({
      component,
      category,
      reason: 'no disposition recorded',
    })),
  );
}

const MIN_RATIONALE = 12;

/**
 * Checks coverage of the grid.
 *
 * Rationale length is checked, and the bar is deliberately low: it rejects
 * `n/a` and `ok`, which are the two ways a grid gets filled in without being
 * thought about, while staying far away from judging whether the reasoning is
 * any good. That judgement is the reviewer's, and a length threshold pretending
 * otherwise would be the same substitution this file exists to refuse.
 */
export function evaluateThreatModel(
  surface: ToolSurface,
  entries: readonly ThreatEntry[],
): ThreatModelResult {
  const byCell = new Map<string, ThreatEntry>();
  for (const entry of entries) {
    byCell.set(`${entry.component}:${entry.category}`, entry);
  }

  const gaps: ThreatModelGap[] = [];
  let answered = 0;

  for (const cell of requiredCells(surface)) {
    const entry = byCell.get(`${cell.component}:${cell.category}`);
    if (entry === undefined) {
      gaps.push(cell);
      continue;
    }
    if (entry.rationale.trim().length < MIN_RATIONALE) {
      // An empty rationale is an unanswered cell wearing an answer's clothes,
      // and it is worse than a blank because it reads as covered.
      gaps.push({
        component: cell.component,
        category: cell.category,
        reason: `disposition "${entry.disposition}" recorded with no rationale`,
      });
      continue;
    }
    answered += 1;
  }

  const required = surface.components.length * STRIDE_CATEGORIES.length;
  return {
    surface: surface.name,
    required,
    answered,
    gaps,
    // Surfaced rather than buried: an accepted risk is the part of a threat
    // model somebody should re-read in six months, and it is the part that
    // silently becomes untrue.
    accepted: entries.filter((entry) => entry.disposition === 'accepted'),
    complete: gaps.length === 0 && required > 0,
  };
}

export function formatThreatModel(result: ThreatModelResult): string {
  const lines = [
    `${result.surface}: ${String(result.answered)}/${String(result.required)} cells dispositioned`,
  ];

  if (result.required === 0) {
    lines.push(
      '',
      'No components declared, so nothing was checked — an empty grid is not a',
      'clean one. Name the trust boundaries this surface crosses.',
    );
    return lines.join('\n');
  }

  if (result.gaps.length > 0) {
    lines.push('', `✗ ${String(result.gaps.length)} cell(s) unanswered`);
    for (const gap of result.gaps.slice(0, 20)) {
      lines.push(`  ${gap.component} × ${gap.category} — ${gap.reason}`);
    }
    if (result.gaps.length > 20) {
      lines.push(`  … and ${String(result.gaps.length - 20)} more`);
    }
  } else {
    lines.push('', '✓ every cell has a disposition');
  }

  if (result.accepted.length > 0) {
    lines.push('', `${String(result.accepted.length)} risk(s) knowingly accepted:`);
    for (const entry of result.accepted) {
      lines.push(`  ${entry.component} × ${entry.category}: ${entry.rationale}`);
    }
  }

  return lines.join('\n');
}
