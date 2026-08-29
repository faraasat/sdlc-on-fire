/**
 * Admitting a CI check run as gate evidence (P6-SURFACE-07, FEAT-EVID-007).
 *
 * `producer: 'ci'` has been in the enum since contract 03 was written, with a
 * confidence weight and a place in `evaluateGate` — and **nothing ever wrote
 * one**. Every gate in this product has been fed by the local daemon, which is
 * the eleventh read path in this codebase with no writer behind it and the
 * reason teams with real CI could not point it at what they already run.
 *
 * The decision here is deliberately a *refusal-heavy* one. There are three ways
 * this feature could quietly manufacture a pass, and each gets an explicit no:
 *
 * 1. **Zero checks is not success.** A ref with no check runs is a repository
 *    where CI did not run, not one where it agreed.
 * 2. **Unfinished is not evidence.** A queued or in-progress check has no
 *    verdict. Writing an envelope for it would hand the gate a "maybe", and
 *    the gate has to turn every input into a pass or a block.
 * 3. **`neutral` and `skipped` are not passes.** Both mean the check declined
 *    to judge. A skipped job is the ordinary result of a path filter, so this
 *    is not a corner case — it is the most likely way a green tick would be
 *    manufactured out of a job that never looked at the code.
 *
 * The check is named by the caller. Guessing `kind` from a job title works
 * until somebody renames "test (20.x)", and then it mislabels silently.
 */

import type { CI_CHECK_STATUSES } from './evidence.js';
import { CI_CHECK_CONCLUSIONS, PASSING_CI_CONCLUSIONS, type CiStatusEvidence } from './evidence.js';

/** One check run, in the shape the provider reports it. */
export interface CheckRun {
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly head_sha: string;
  readonly html_url?: string | null;
}

export type CiAdmissionRefusal =
  'no-checks' | 'check-not-found' | 'not-finished' | 'unknown-conclusion';

/**
 * The verdict on one check run.
 *
 * `payload` is present exactly when `admitted` — a refusal has nothing to
 * write, and every construction below upholds that. Readers may therefore key
 * on `payload` alone.
 */
export interface CiAdmission {
  readonly admitted: boolean;
  readonly payload?: CiStatusEvidence | undefined;
  readonly refusal?: CiAdmissionRefusal | undefined;
  readonly reason?: string | undefined;
}

/** The check names actually present on a ref, deduped and sorted. */
export function checkNames(runs: readonly CheckRun[]): readonly string[] {
  return [...new Set(runs.map((run) => run.name))].sort();
}

/**
 * The run to judge when a name appears more than once.
 *
 * A re-run leaves the old attempt in the listing, so "the check called X"
 * is genuinely ambiguous. The **last completed** one wins: GitHub returns
 * check runs newest-first, and taking a completed run over a queued re-run
 * answers the question the caller asked ("did X pass on this commit") rather
 * than "is X currently busy".
 */
export function selectRun(runs: readonly CheckRun[], name: string): CheckRun | null {
  const matching = runs.filter((run) => run.name === name);
  return matching.find((run) => run.status === 'completed') ?? matching[0] ?? null;
}

export function admitCheckRun(
  runs: readonly CheckRun[],
  check: string,
  provider = 'github',
): CiAdmission {
  if (runs.length === 0) {
    return {
      admitted: false,
      refusal: 'no-checks',
      reason:
        'this ref has no check runs at all — that is a CI that did not run, not a CI that agreed',
    };
  }

  const run = selectRun(runs, check);
  if (run === null) {
    return {
      admitted: false,
      refusal: 'check-not-found',
      reason: `no check named "${check}" on this ref. Present: ${checkNames(runs).join(', ')}`,
    };
  }

  if (run.status !== 'completed' || run.conclusion === null) {
    return {
      admitted: false,
      refusal: 'not-finished',
      reason: `"${check}" is ${run.status} — it has no verdict yet, and a gate cannot act on "maybe"`,
    };
  }

  if (!(CI_CHECK_CONCLUSIONS as readonly string[]).includes(run.conclusion)) {
    // A provider that grew a new conclusion value. Refused rather than mapped
    // onto the nearest known one, because the nearest one is a guess and the
    // guess most likely to be made is `success`.
    return {
      admitted: false,
      refusal: 'unknown-conclusion',
      reason: `"${check}" concluded "${run.conclusion}", which is not a value this version knows. Refusing rather than guessing which way it points.`,
    };
  }

  const status = run.status as (typeof CI_CHECK_STATUSES)[number];
  const conclusion = run.conclusion as (typeof CI_CHECK_CONCLUSIONS)[number];

  return {
    admitted: true,
    payload: {
      provider,
      check: run.name,
      status,
      conclusion,
      ...(typeof run.html_url === 'string' && run.html_url !== '' ? { url: run.html_url } : {}),
      head_sha: run.head_sha,
      ok: PASSING_CI_CONCLUSIONS.has(conclusion),
    },
  };
}

export function formatAdmission(admission: CiAdmission, check: string): string {
  if (!admission.admitted)
    return `✗ no evidence written for "${check}" — ${admission.reason ?? ''}`;
  const payload = admission.payload;
  if (payload === undefined) return `✗ no evidence written for "${check}"`;
  return [
    `${payload.ok ? '✓' : '✗'} ${payload.check}: ${payload.conclusion}`,
    `  commit ${payload.head_sha.slice(0, 8)}`,
    ...(payload.url === undefined ? [] : [`  ${payload.url}`]),
    ...(payload.ok
      ? []
      : [`  recorded as failing evidence — "${payload.conclusion}" is not a pass`]),
  ].join('\n');
}
