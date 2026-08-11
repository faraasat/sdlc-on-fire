import fs from 'node:fs/promises';
import path from 'node:path';
import { classifyPackage, type PackageAssessment, type PackageIntelPort } from '@sdlc-on-fire/core';
import {
  evaluateInstallGate,
  formatInstallGate,
  type InstallGateResult,
} from '@sdlc-on-fire/evidence';
import { createOsvIntel } from '@sdlc-on-fire/daemon';

/**
 * `sdlc deps check` (P2-SEC-01).
 *
 * The command surface exists because a check nobody can run is not a check —
 * the v0.1 DoD walkthrough found exactly that shape once already, where the
 * skill compiler and doctor shipped as tested library code with nothing wired
 * to a command.
 *
 * Reads the dependency list straight from `package.json` rather than asking for
 * names: the packages that matter are the ones a project actually resolves, and
 * a list typed by hand is a list of what someone remembers.
 */

export interface DepsCheckResult {
  readonly root: string;
  readonly intel: string;
  readonly packages: readonly PackageAssessment[];
  readonly gate: InstallGateResult;
  /** Why the lookup came back empty-handed, when it did. */
  readonly degraded?: string | undefined;
}

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

/** Every declared dependency, deduplicated, with the range as declared. */
export async function declaredDependencies(
  root: string,
): Promise<readonly { name: string; ecosystem: string; version?: string | undefined }[]> {
  const raw = await fs.readFile(path.join(root, 'package.json'), 'utf8').catch(() => null);
  if (raw === null) return [];

  let parsed: PackageJson;
  try {
    parsed = JSON.parse(raw) as PackageJson;
  } catch {
    return [];
  }

  const seen = new Map<string, string | undefined>();
  for (const group of [parsed.dependencies, parsed.devDependencies, parsed.optionalDependencies]) {
    for (const [name, range] of Object.entries(group ?? {})) {
      // A workspace protocol range is our own package, not a registry one —
      // querying it would produce an `assumed` verdict for code we wrote.
      if (typeof range === 'string' && range.startsWith('workspace:')) continue;
      if (!seen.has(name)) seen.set(name, typeof range === 'string' ? range : undefined);
    }
  }

  return [...seen.entries()].map(([name, version]) => ({
    name,
    ecosystem: 'npm',
    ...(version === undefined ? {} : { version }),
  }));
}

export async function checkDependencies(
  root: string,
  options: {
    readonly intel?: PackageIntelPort | undefined;
    readonly approveEveryInstall?: boolean | undefined;
  } = {},
): Promise<DepsCheckResult> {
  let degraded: string | undefined;
  const intel = options.intel ?? createOsvIntel({ onDegraded: (reason) => (degraded = reason) });
  const declared = await declaredDependencies(root);
  const signals = await intel.lookup(declared);
  const packages = signals.map((signal) => classifyPackage(signal));

  return {
    root,
    intel: intel.id,
    packages,
    ...(degraded === undefined ? {} : { degraded }),
    gate: evaluateInstallGate(packages, {
      ...(options.approveEveryInstall === undefined
        ? {}
        : { approveEveryInstall: options.approveEveryInstall }),
    }),
  };
}

export function formatDepsCheck(result: DepsCheckResult): string {
  const lines = [
    `${String(result.packages.length)} dependency(ies) checked via ${result.intel}`,
    '',
    formatInstallGate(result.gate),
  ];
  if (result.packages.length > 0 && result.packages.every((p) => p.verdict === 'assumed')) {
    // Said plainly rather than left for someone to infer from a wall of
    // identical verdicts. An all-`assumed` run means the lookup did not
    // happen — offline, rate-limited, or an ecosystem OSV does not carry.
    lines.push(
      '',
      'Every package came back unverified, which means the advisory lookup did not',
      'reach anything — not that the packages are clean.',
    );
    // Naming the cause is the difference between "you are offline" and "this
    // checker is broken". Those look identical in the verdicts and need
    // completely different responses.
    lines.push(
      result.degraded === undefined
        ? 'No failure was reported, so check the ecosystem is one osv.dev carries.'
        : `Cause: ${result.degraded}`,
    );
  }
  return lines.join('\n');
}
