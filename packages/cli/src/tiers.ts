import fs from 'node:fs/promises';
import path from 'node:path';
import {
  evaluateTiers,
  extraTiers,
  formatTierReport,
  REQUIRED_TIERS,
  tierOf,
  type TestTier,
  type TierReport,
  type TierRun,
} from '@sdlc-on-fire/core';

/**
 * `sdlc tiers` — which test tiers this repository actually has (P2-QA-01).
 *
 * Two questions, and they are different enough to keep apart:
 *
 * - **Discovery** walks the tree and reports which tiers exist as files. A tier
 *   a preset requires and the repository has no files for is a gap in the
 *   *suite*, and no amount of running tests will surface it — the runner
 *   matches nothing, exits 0, and the tier looks fine.
 * - **Evaluation** takes the runs that actually happened and asks whether the
 *   required tiers are satisfied. That is the gate's question.
 *
 * The first is why the command exists at all. `evaluateTiers` can only report
 * on runs it was handed; a repository with no integration tests at all never
 * produces an integration run to be missing, so the absence has to be found by
 * looking at the files rather than at the results.
 */

/** Directories never worth walking for test files. */
const SKIP = new Set(['node_modules', '.git', 'dist', 'coverage', '.sdlcof', '.next', 'build']);

export interface TierInventory {
  readonly tier: TestTier;
  readonly files: readonly string[];
}

export async function discoverTiers(root: string): Promise<TierInventory[]> {
  const byTier = new Map<TestTier, string[]>();

  const walk = async (dir: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP.has(entry.name)) await walk(full);
        continue;
      }
      const tier = tierOf(path.relative(root, full));
      if (tier === null) continue;
      const list = byTier.get(tier) ?? [];
      list.push(path.relative(root, full));
      byTier.set(tier, list);
    }
  };

  await walk(root);
  return [...byTier.entries()]
    .map(([tier, files]) => ({ tier, files: files.sort() }))
    .sort((a, b) => a.tier.localeCompare(b.tier));
}

export interface TiersResult {
  readonly preset: string;
  readonly inventory: readonly TierInventory[];
  /** Required tiers this repository has no files for at all. */
  readonly unwritten: readonly TestTier[];
  readonly report: TierReport;
  readonly extra: readonly TestTier[];
}

/**
 * Reports the tiers, treating "no files" as its own finding.
 *
 * A tier with no files is fed to {@link evaluateTiers} as a zero-test run
 * rather than omitted, so it lands as `empty` — which is the honest reading. A
 * repository with no integration tests has an integration tier that executes
 * nothing, and the gate should refuse that for the same reason it refuses a
 * runner that matched no files.
 */
export async function reportTiers(root: string, preset = 'standard'): Promise<TiersResult> {
  const inventory = await discoverTiers(root);
  const have = new Map(inventory.map((entry) => [entry.tier, entry]));

  const required = REQUIRED_TIERS[preset] ?? REQUIRED_TIERS['standard'] ?? [];
  const unwritten = required.filter((tier) => !have.has(tier));

  const runs: TierRun[] = inventory.map((entry) => ({
    tier: entry.tier,
    total: entry.files.length,
    passed: entry.files.length,
    failed: 0,
  }));

  return {
    preset,
    inventory,
    unwritten,
    // Counts *files*, not tests: this command reports what exists, and whether
    // those files pass is `sdlc verify`'s question, asked against a real run.
    report: evaluateTiers(preset, runs),
    extra: extraTiers(preset, runs),
  };
}

export function formatTiers(result: TiersResult): string {
  const lines: string[] = [];

  for (const entry of result.inventory) {
    lines.push(`  ${entry.tier.padEnd(12)} ${String(entry.files.length)} file(s)`);
  }
  if (result.inventory.length === 0) lines.push('  no test files found');

  lines.push('', formatTierReport(result.preset, result.report, result.extra));

  if (result.unwritten.length > 0) {
    lines.push(
      '',
      `These tiers have no files at all: ${result.unwritten.join(', ')}.`,
      'A tier with nothing in it is not a tier that passes — the runner matches',
      'nothing, exits 0, and the absence looks exactly like success.',
    );
  }

  return lines.join('\n');
}
