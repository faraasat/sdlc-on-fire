/**
 * License-compatibility classification (P2-SEC-08, ADR-0033).
 *
 * The question is narrow and answerable: does a dependency's license impose
 * obligations this project's own license cannot carry? For an MIT project, a
 * GPL dependency does — GPL requires derived works be GPL, and MIT cannot
 * promise that.
 *
 * **This classifies; it does not give legal advice, and the difference is
 * load-bearing.** Whether a particular use creates a derived work depends on
 * how the code is linked, whether it runs in a separate process, and whose
 * jurisdiction is asking. No table settles that. So strong copyleft is *flagged
 * for a human* rather than declared an infringement, and the output says which
 * obligation triggered the flag so the person deciding has something concrete.
 *
 * **Unknown is never permissive.** A package with no `license` field gets
 * `unknown`, which needs review — the same fail-closed shape as the advisory
 * check in P2-SEC-01, and for the same reason: a missing field means nobody
 * looked, and reading that as "no obligations" converts silence into consent.
 */

export const LICENSE_CLASSES = [
  'permissive',
  'weak-copyleft',
  'strong-copyleft',
  'network-copyleft',
  'proprietary',
  'public-domain',
  'unknown',
] as const;

export type LicenseClass = (typeof LICENSE_CLASSES)[number];

/**
 * SPDX identifiers by class.
 *
 * Matched case-insensitively against the SPDX id, so `Apache-2.0` and
 * `apache-2.0` are one entry.
 */
const CLASSIFICATION: Readonly<Record<string, LicenseClass>> = {
  mit: 'permissive',
  'mit-0': 'permissive',
  isc: 'permissive',
  'bsd-2-clause': 'permissive',
  'bsd-3-clause': 'permissive',
  'apache-2.0': 'permissive',
  'blueoak-1.0.0': 'permissive',
  'python-2.0': 'permissive',
  zlib: 'permissive',
  unlicense: 'public-domain',
  'cc0-1.0': 'public-domain',
  '0bsd': 'public-domain',
  // Weak copyleft: obligations attach to the library's own files, not to the
  // whole program. Usually fine to depend on; not always fine to vendor.
  'lgpl-2.1': 'weak-copyleft',
  'lgpl-2.1-only': 'weak-copyleft',
  'lgpl-2.1-or-later': 'weak-copyleft',
  'lgpl-3.0': 'weak-copyleft',
  'lgpl-3.0-only': 'weak-copyleft',
  'lgpl-3.0-or-later': 'weak-copyleft',
  'mpl-2.0': 'weak-copyleft',
  'epl-2.0': 'weak-copyleft',
  'cddl-1.0': 'weak-copyleft',
  'gpl-2.0': 'strong-copyleft',
  'gpl-2.0-only': 'strong-copyleft',
  'gpl-2.0-or-later': 'strong-copyleft',
  'gpl-3.0': 'strong-copyleft',
  'gpl-3.0-only': 'strong-copyleft',
  'gpl-3.0-or-later': 'strong-copyleft',
  // Network copyleft is called out separately from GPL because it is the one
  // that catches hosted software: AGPL's obligation triggers on *serving* the
  // program over a network, with no distribution required. A team that
  // correctly reasoned "we never ship binaries, so GPL cannot reach us" is
  // exactly the team AGPL surprises.
  'agpl-3.0': 'network-copyleft',
  'agpl-3.0-only': 'network-copyleft',
  'agpl-3.0-or-later': 'network-copyleft',
  'sspl-1.0': 'network-copyleft',
  unlicensed: 'proprietary',
  'busl-1.1': 'proprietary',
  'elastic-2.0': 'proprietary',
};

export interface LicenseAssessment {
  readonly name: string;
  readonly license: string;
  readonly class: LicenseClass;
  /** True when it needs a human before this project can depend on it. */
  readonly flagged: boolean;
  readonly reason: string;
}

/** How severe each class is, so the worst term in an expression wins. */
const SEVERITY: Readonly<Record<LicenseClass, number>> = {
  'public-domain': 0,
  permissive: 1,
  unknown: 2,
  'weak-copyleft': 3,
  proprietary: 4,
  'strong-copyleft': 5,
  'network-copyleft': 6,
};

export function classifyLicense(expression: string | undefined | null): LicenseClass {
  if (expression === undefined || expression === null) return 'unknown';
  const trimmed = expression.trim();
  if (trimmed === '') return 'unknown';

  const terms = trimmed
    .replaceAll(/[()]/g, ' ')
    .split(/\s+(?:OR|AND|WITH)\s+/i)
    .map((term) => term.trim().replace(/\+$/, '').toLowerCase())
    .filter((term) => term !== '');

  if (terms.length === 0) return 'unknown';

  const classes = terms.map((term) => CLASSIFICATION[term] ?? 'unknown');

  // `(MIT OR GPL-3.0)` is a *choice*, and a project may take the permissive
  // side — so a dual license is as permissive as its most permissive option.
  // `MIT AND GPL-3.0` is a conjunction: every obligation applies, so the worst
  // term wins. Collapsing these two would either flag every dual-licensed
  // package or wave through a genuine conjunction.
  const isChoice = /\sOR\s/i.test(trimmed);
  const pick = isChoice
    ? (a: LicenseClass, b: LicenseClass) => (SEVERITY[a] <= SEVERITY[b] ? a : b)
    : (a: LicenseClass, b: LicenseClass) => (SEVERITY[a] >= SEVERITY[b] ? a : b);

  return classes.reduce(pick);
}

/**
 * Whether a dependency's license is compatible with the project's.
 *
 * `projectClass` is derived from the project's own declared license, so an
 * AGPL project is not warned about its AGPL dependencies — the obligation it
 * would be warned about is one it has already taken on.
 */
export function assessLicense(
  name: string,
  expression: string | undefined | null,
  projectLicense = 'MIT',
): LicenseAssessment {
  const licenseClass = classifyLicense(expression);
  const projectClass = classifyLicense(projectLicense);
  const license = expression?.trim() === '' ? '(none declared)' : (expression ?? '(none declared)');

  // A project already carrying the same or stronger obligation is not
  // constrained further by this dependency.
  if (SEVERITY[licenseClass] <= SEVERITY[projectClass] && licenseClass !== 'unknown') {
    return {
      name,
      license,
      class: licenseClass,
      flagged: false,
      reason: `${licenseClass} — no obligation beyond this project’s own ${projectLicense}`,
    };
  }

  const reasons: Readonly<Record<LicenseClass, string>> = {
    'network-copyleft': `network copyleft — obligations trigger on *serving* the software, not only on distributing it, so "we never ship binaries" does not avoid them`,
    'strong-copyleft': `strong copyleft — requires derived works carry the same license, which ${projectLicense} cannot promise`,
    'weak-copyleft': `weak copyleft — obligations attach to this library's own files; usually fine to depend on, not always fine to vendor or modify`,
    proprietary:
      'proprietary or source-available — usage is restricted by terms, not by an open licence',
    unknown: 'no recognised license declared — treated as unreviewed, not as unencumbered',
    permissive: 'permissive',
    'public-domain': 'public domain',
  };

  return {
    name,
    license,
    class: licenseClass,
    flagged: true,
    reason: reasons[licenseClass],
  };
}

export interface LicenseGateResult {
  readonly decision: 'needs-human' | 'clean';
  readonly flagged: readonly LicenseAssessment[];
  readonly cleared: readonly LicenseAssessment[];
  readonly reasons: readonly string[];
}

/**
 * The gate verdict for a whole dependency set.
 *
 * There is no `blocked` here, deliberately. A license question is a decision
 * with a legal dimension, and a tool that refuses outright on a table lookup
 * would be asserting a conclusion it is not equipped to reach. Flag it, name
 * the obligation, and let a person decide.
 */
export function evaluateLicenseGate(assessments: readonly LicenseAssessment[]): LicenseGateResult {
  const flagged = [...assessments]
    .filter((a) => a.flagged)
    .sort((a, b) => SEVERITY[b.class] - SEVERITY[a.class] || a.name.localeCompare(b.name));
  const cleared = assessments.filter((a) => !a.flagged);

  return {
    decision: flagged.length > 0 ? 'needs-human' : 'clean',
    flagged,
    cleared,
    reasons: flagged.map((a) => `${a.name} (${a.license}): ${a.reason}`),
  };
}
