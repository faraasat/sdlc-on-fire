/**
 * Test tiers as data (P2-QA-01, ADR-0044, `testing-strategy.md §2`).
 *
 * The taxonomy already names unit, integration, smoke, regression and e2e — and
 * all but e2e arrive at the gate as the same `kind: 'test'` envelope,
 * distinguished only by a naming convention inside the test files. That is fine
 * for reporting and useless for gating: a preset can require "tests", and
 * cannot require "the integration tier actually ran".
 *
 * The distinction is worth having because the tiers fail differently. A unit
 * suite passing while the integration suite was never run is the normal shape
 * of a broken seam — every part correct, nothing wired. Nothing about the
 * envelope stream says so, because a run that did not happen produces no
 * envelope, and no envelope looks exactly like nothing to worry about.
 *
 * So: **a required tier with no evidence is `missing`, never `passed`.** That
 * is the whole load-bearing claim here, and it is the same rule the gate
 * already applies to individual checks, applied one level up — to the question
 * of which *kinds* of check were run at all.
 */

import type { EvidenceKind } from './evidence.js';

export const TEST_TIERS = [
  'unit',
  'integration',
  'smoke',
  'regression',
  'property',
  'e2e',
] as const;
export type TestTier = (typeof TEST_TIERS)[number];

export interface TierDefinition {
  readonly tier: TestTier;
  /** The envelope kind a run of this tier produces. */
  readonly kind: EvidenceKind;
  /** Filename markers that place a test file in this tier, checked in order. */
  readonly markers: readonly string[];
  readonly purpose: string;
}

/**
 * How a test file is placed in a tier.
 *
 * Filename markers rather than a registry someone maintains: the tier of a test
 * has to be derivable from the repository itself, or it drifts the first time
 * somebody adds a file and forgets the list. `testing-strategy.md §2` already
 * specifies the convention (`*.integration.test.ts` and friends), so this reads
 * what the convention already writes.
 *
 * Order matters. `smoke` is checked before `unit` because `a.smoke.test.ts`
 * ends in `.test.ts` and would otherwise be counted as a unit test — which
 * would mean the smoke tier silently never runs while looking like it did.
 */
export const TIER_DEFINITIONS: readonly TierDefinition[] = [
  {
    tier: 'e2e',
    kind: 'e2e',
    markers: ['.e2e.test.', '.e2e.spec.', '/e2e/'],
    purpose: 'a full flow through the real system, no mocked seams',
  },
  {
    tier: 'property',
    kind: 'test',
    markers: ['.property.test.', '.property.spec.', '.prop.test.', '/property/'],
    purpose:
      'a claim that must hold across generated inputs the author did not choose — ' +
      'much harder to satisfy vacuously than an example, and derived from the ' +
      'signature rather than from the implementation body (P3-QA-11)',
  },
  {
    tier: 'integration',
    kind: 'test',
    markers: ['.integration.test.', '.integration.spec.', '/integration/'],
    purpose: 'two or more real units composed, with nothing mocked at the seam under test',
  },
  {
    tier: 'smoke',
    kind: 'test',
    markers: ['.smoke.test.', '.smoke.spec.', '/smoke/'],
    purpose: 'shallow and fast — did the build catch fire',
  },
  {
    tier: 'regression',
    kind: 'test',
    markers: ['.regression.test.', '.regression.spec.', '/regression/'],
    purpose: 'a permanent case for every bug already caught once',
  },
  {
    tier: 'unit',
    kind: 'test',
    markers: ['.test.', '.spec.'],
    purpose: 'one module in isolation — the red-green-refactor cycle',
  },
];

/**
 * The tier a test file belongs to, or `null` when it is not a test file.
 *
 * `null` rather than a default tier. Guessing `unit` for an unrecognised file
 * would inflate the unit tier with things that are not unit tests, and — worse
 * — would make an unrecognised naming scheme look like full coverage of a tier
 * nobody actually wrote.
 */
export function tierOf(filePath: string): TestTier | null {
  const normalised = filePath.replaceAll('\\', '/');
  for (const definition of TIER_DEFINITIONS) {
    if (definition.markers.some((marker) => normalised.includes(marker))) return definition.tier;
  }
  return null;
}

/**
 * Tiers each preset requires, per `testing-strategy.md §3`.
 *
 * `lite` asks for unit only — a team that chose cheap gets the cycle that makes
 * TDD possible and nothing else. `standard` adds integration and regression,
 * because the seam bugs and the bugs you already paid for once are the two
 * classes worth the time. `strict` adds smoke and e2e.
 *
 * Deliberately additive across presets: every tier a lower preset requires, a
 * higher one requires too. A preset that dropped a tier the level below
 * demanded would make "stricter" a claim rather than a fact.
 */
export const REQUIRED_TIERS: Readonly<Record<string, readonly TestTier[]>> = {
  lite: ['unit'],
  standard: ['unit', 'integration', 'regression'],
  // `property` is required only at strict: a property test is the cheapest
  // approximation of a held-out check (it asserts what the signature promised,
  // not what the body does), and requiring it below strict would make every
  // existing project red on upgrade.
  strict: ['unit', 'integration', 'regression', 'smoke', 'property', 'e2e'],
};

export interface TierRun {
  readonly tier: TestTier;
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
}

/**
 * The verdicts a tier can carry.
 *
 * `present` is the discovery-mode one and is deliberately not `passed`: files
 * existing is a different fact from tests passing, and a report that shares a
 * word between them will eventually be read as the stronger claim.
 */
export const TIER_STATUSES = ['passed', 'failed', 'missing', 'empty', 'present'] as const;
export type TierStatus = (typeof TIER_STATUSES)[number];

export interface TierFinding {
  readonly tier: TestTier;
  readonly status: TierStatus;
  readonly detail: string;
}

export interface TierReport {
  readonly findings: readonly TierFinding[];
  readonly satisfied: boolean;
}

/**
 * Whether the tiers a preset requires actually ran, and passed.
 *
 * Four statuses, and the two that are not obvious carry the value:
 *
 * - `missing` — the tier produced no run at all. Distinct from `failed`
 *   because they ask for opposite work: one means fix the code, the other
 *   means write or wire up the tests.
 * - `empty` — the tier ran and executed zero tests. A runner that matched no
 *   files exits 0, and exit 0 with no assertions is the most convincing-looking
 *   nothing in software. It is never a pass here.
 */
/**
 * What a tier report is about.
 *
 * `run` means a runner executed and these are its counts. `discovery` means
 * somebody listed files and nobody ran anything — and the two must not share a
 * vocabulary, because they did not share an event.
 *
 * This is not hypothetical. `sdlc tiers` synthesised a `TierRun` per tier from
 * a *file count* and rendered it through the run formatter, so pointing it at
 * a real repository printed **"85/85 unit tests passed"** for a suite that had
 * never been executed. The module comment said it counted files; the output
 * said the tests passed. This product exists to refuse exactly that sentence
 * from an agent, and it was producing it about itself. Found by running the
 * built binary against an unrelated repository (P2-QA-07, ADR-0064).
 */
export type TierReportMode = 'run' | 'discovery';

export function evaluateTiers(
  preset: string,
  runs: readonly TierRun[],
  mode: TierReportMode = 'run',
): TierReport {
  const required = REQUIRED_TIERS[preset] ?? REQUIRED_TIERS['standard'] ?? [];
  const byTier = new Map(runs.map((run) => [run.tier, run]));

  const findings = required.map((tier): TierFinding => {
    const run = byTier.get(tier);
    if (run === undefined) {
      return {
        tier,
        status: 'missing',
        detail:
          mode === 'discovery'
            ? `no ${tier} test files found`
            : `the ${tier} tier produced no run — a tier that did not execute is not a tier that passed`,
      };
    }
    if (mode === 'discovery') {
      // Presence, and nothing about outcomes. Whether these files pass is
      // `sdlc verify`'s question, asked against a real run.
      return run.total === 0
        ? { tier, status: 'empty', detail: `no ${tier} test files found` }
        : {
            tier,
            status: 'present',
            detail: `${String(run.total)} ${tier} test file(s) present — not run, so not passing`,
          };
    }
    if (run.total === 0) {
      return {
        tier,
        status: 'empty',
        detail: `the ${tier} tier ran and executed 0 tests — a runner that matched no files exits 0, which is not the same as passing`,
      };
    }
    if (run.failed > 0) {
      return {
        tier,
        status: 'failed',
        detail: `${String(run.failed)} of ${String(run.total)} ${tier} tests failed`,
      };
    }
    return {
      tier,
      status: 'passed',
      detail: `${String(run.passed)}/${String(run.total)} ${tier} tests passed`,
    };
  });

  return {
    findings,
    // `present` is not `passed`, so a discovery report is never satisfied. That
    // is the property: listing files can no longer satisfy a tier requirement.
    satisfied: findings.every((finding) => finding.status === 'passed'),
  };
}

/**
 * Tiers that ran but nothing asked for.
 *
 * Reported rather than ignored, and *never* as a problem: a team running e2e on
 * `standard` is doing more than required, which is the direction nobody needs
 * warning about. It is surfaced so the report describes what happened rather
 * than only what was demanded.
 */
export function extraTiers(preset: string, runs: readonly TierRun[]): TestTier[] {
  const required = new Set(REQUIRED_TIERS[preset] ?? []);
  return runs.filter((run) => !required.has(run.tier)).map((run) => run.tier);
}

export function formatTierReport(
  preset: string,
  report: TierReport,
  extra: readonly TestTier[] = [],
): string {
  const mark = { passed: '✓', failed: '✗', missing: '·', empty: '⚠', present: '·' } as const;
  const discovery = report.findings.some((finding) => finding.status === 'present');
  const lines = [
    discovery
      ? `Test tiers \`${preset}\` requires, and which this repository has files for:`
      : `Test tiers required by \`${preset}\`:`,
  ];
  for (const finding of report.findings) {
    lines.push(`  ${mark[finding.status]} ${finding.tier} — ${finding.detail}`);
  }
  if (extra.length > 0) {
    lines.push('', `  also ${discovery ? 'present' : 'ran'} (not required): ${extra.join(', ')}`);
  }
  lines.push(
    '',
    discovery
      ? 'Nothing was run. `sdlc verify` is what asks whether these pass.'
      : report.satisfied
        ? 'Every required tier ran and passed.'
        : 'Required tiers are not satisfied.',
  );
  return lines.join('\n');
}
