/**
 * Did the gates get weaker? (P8-BAR-03, ADR-0063 / `metrics.md` §3a.)
 *
 * `metrics.md` calls preset-downgrade and gate-disable **"the clearest
 * abandonment leading indicator"**, and R-08 is the same failure written as a
 * risk: gates configured too strict push people to `lite`, which defeats the
 * one thing that differentiates this product. Both descriptions assume the
 * change is *observable*. It was not. `.sdlcof/config.yaml` is an ordinary file
 * a person edits, `sdlc config` only reads it, and nothing anywhere compared
 * one reading to the previous one.
 *
 * ## What "weaker" means here, and why it is a list rather than a score
 *
 * Five settings decide how much the harness is allowed to stop you. Each is
 * classified on its own and the overall direction is the worst move any of them
 * made, because a config that tightens the sandbox while dropping to `lite` has
 * not stayed level — it has done the thing the indicator exists to catch, and a
 * score would net it out to nothing.
 *
 * ## This is a sampled signal and says so
 *
 * There is no hook on a text editor. A snapshot is taken when a command that
 * reads the config happens to run, so an event records **when the change was
 * observed**, never when it was made, and two changes between observations
 * collapse into one. That is a real limit and the field is named `observedAt`
 * so a reader cannot mistake it for a change feed. The alternative — inferring
 * a timestamp from the file's mtime — would produce a precise-looking number
 * that is wrong whenever a checkout, a format-on-save or a `git stash` touched
 * the file.
 */

/** Weakest first. The order *is* the definition of a downgrade. */
export const PRESET_STRENGTH = ['lite', 'standard', 'strict'] as const;
export type PresetStrength = (typeof PRESET_STRENGTH)[number];

export const DRIFT_DIRECTIONS = ['weakened', 'strengthened', 'mixed', 'unchanged'] as const;
export type DriftDirection = (typeof DRIFT_DIRECTIONS)[number];

/** The settings that decide how much the harness may stop you. */
export interface GateStrengthConfig {
  readonly preset: string;
  readonly mode: string;
  readonly sandboxTier: string;
  readonly sandboxRequired: boolean;
  readonly autoApproveUnambiguous: boolean;
}

export interface DriftChange {
  readonly field: keyof GateStrengthConfig;
  readonly from: string;
  readonly to: string;
  readonly effect: 'weakened' | 'strengthened';
  readonly because: string;
}

export interface ConfigDrift {
  readonly direction: DriftDirection;
  readonly changes: readonly DriftChange[];
  readonly because: string;
}

const SANDBOX_STRENGTH = ['none', 'seatbelt', 'bubblewrap'] as const;

function rank(order: readonly string[], value: string): number {
  const index = order.indexOf(value);
  // An unknown value is not silently the weakest. Ranking it -1 would make a
  // typo in the config read as a downgrade and fire the abandonment signal on
  // somebody who fat-fingered a word.
  return index === -1 ? Number.NaN : index;
}

function ordered(
  field: keyof GateStrengthConfig,
  order: readonly string[],
  from: string,
  to: string,
  because: string,
): DriftChange | null {
  if (from === to) return null;
  const a = rank(order, from);
  const b = rank(order, to);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return { field, from, to, effect: b < a ? 'weakened' : 'strengthened', because };
}

function toggled(
  field: keyof GateStrengthConfig,
  from: boolean,
  to: boolean,
  /** Which value is the stronger one. */
  strongerWhen: boolean,
  because: string,
): DriftChange | null {
  if (from === to) return null;
  return {
    field,
    from: String(from),
    to: String(to),
    effect: to === strongerWhen ? 'strengthened' : 'weakened',
    because,
  };
}

/**
 * How the gate strength moved between two readings of the config.
 *
 * Deterministic and total: every field is compared, every change is named with
 * its direction and its reason, and nothing is inferred from anything outside
 * these five values (ADR-0040).
 */
export function classifyConfigDrift(
  before: GateStrengthConfig,
  after: GateStrengthConfig,
): ConfigDrift {
  const changes = [
    ordered(
      'preset',
      PRESET_STRENGTH,
      before.preset,
      after.preset,
      'the preset decides which gates apply at all',
    ),
    ordered(
      'sandboxTier',
      SANDBOX_STRENGTH,
      before.sandboxTier,
      after.sandboxTier,
      'the sandbox tier decides how confined a verify run is',
    ),
    toggled(
      'sandboxRequired',
      before.sandboxRequired,
      after.sandboxRequired,
      true,
      'without `required`, a missing sandbox is a warning rather than a refusal — a control becomes a suggestion',
    ),
    toggled(
      'autoApproveUnambiguous',
      before.autoApproveUnambiguous,
      after.autoApproveUnambiguous,
      false,
      'auto-approving an unambiguous restatement removes a human checkpoint from intake',
    ),
    // `team` → `solo` is a downgrade even though neither word sounds like one:
    // solo auto-satisfies an approval rule nobody but the author could meet, so
    // the same board that deadlocked yesterday advances today.
    toggled(
      'mode',
      before.mode === 'team',
      after.mode === 'team',
      true,
      'solo auto-satisfies an approval rule only the author could meet; team deadlocks and names the missing role',
    ),
  ].filter((change): change is DriftChange => change !== null);

  const weakened = changes.filter((change) => change.effect === 'weakened');
  const strengthened = changes.filter((change) => change.effect === 'strengthened');

  const direction: DriftDirection =
    changes.length === 0
      ? 'unchanged'
      : weakened.length > 0 && strengthened.length > 0
        ? 'mixed'
        : weakened.length > 0
          ? 'weakened'
          : 'strengthened';

  return {
    direction,
    changes,
    because:
      changes.length === 0
        ? 'no gate-strength setting moved'
        : changes
            .map((change) => `${change.field}: ${change.from} → ${change.to} (${change.effect})`)
            .join('; '),
  };
}

/**
 * Whether this drift is the one the abandonment indicator is watching for.
 *
 * `mixed` counts. A config that tightened the sandbox and dropped to `lite` has
 * still dropped to `lite`, and letting one improvement cancel the signal is how
 * a leading indicator stops leading.
 */
export function isDowngrade(drift: ConfigDrift): boolean {
  return drift.changes.some((change) => change.effect === 'weakened');
}
