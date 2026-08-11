import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { detectRiskSurfaces, type ChangedFile, type SurfaceFinding } from '@sdlc-on-fire/core';
import {
  requireSecurityReview,
  riskCardsFor,
  type RiskCard,
  type SecurityReviewRequirement,
} from '@sdlc-on-fire/evidence';

/**
 * `sdlc risk` (P2-SEC-03).
 *
 * Reads a real diff from git rather than taking a file list, for the same
 * reason `deps check` reads `package.json`: the files that matter are the ones
 * a change actually touched, and a list typed by hand is a list of what someone
 * remembers touching.
 */

const run = promisify(execFile);

export type GitRunner = (args: readonly string[]) => Promise<string>;

const defaultGit =
  (cwd: string): GitRunner =>
  async (args) => {
    const { stdout } = await run('git', [...args], { cwd, maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  };

/**
 * The files a diff touches, with the lines it **adds**.
 *
 * Added lines only: a content rule run over whole files would fire on every
 * change to any file that has ever contained a `fetch(`, and a gate that fires
 * on everything is one people learn to click through.
 */
export async function changedFiles(base: string, git: GitRunner): Promise<readonly ChangedFile[]> {
  const raw = await git(['diff', '--unified=0', '--no-color', base]).catch(() => '');
  const files = new Map<string, string[]>();

  let current: string | null = null;
  for (const line of raw.split('\n')) {
    const header = /^\+\+\+ b\/(.+)$/.exec(line);
    if (header !== null) {
      current = header[1] ?? null;
      // `/dev/null` is a deletion; a removed file introduces no new surface.
      if (current === null || current === 'ev/null') current = null;
      else if (!files.has(current)) files.set(current, []);
      continue;
    }
    if (current === null) continue;
    // `+++` is a header, not an added line.
    if (line.startsWith('+') && !line.startsWith('+++')) {
      files.get(current)?.push(line.slice(1));
    }
  }

  return [...files.entries()].map(([path, added]) => ({
    path,
    ...(added.length > 0 ? { addedContent: added.join('\n') } : {}),
  }));
}

export interface RiskCheckResult {
  readonly base: string;
  readonly filesChanged: number;
  readonly findings: readonly SurfaceFinding[];
  readonly requirement: SecurityReviewRequirement;
  readonly cards: readonly RiskCard[];
}

export async function checkRisk(
  root: string,
  options: { readonly base?: string | undefined; readonly git?: GitRunner | undefined } = {},
): Promise<RiskCheckResult> {
  const base = options.base ?? 'HEAD';
  const git = options.git ?? defaultGit(root);
  const files = await changedFiles(base, git);
  const findings = detectRiskSurfaces(files);

  return {
    base,
    filesChanged: files.length,
    findings,
    requirement: requireSecurityReview(findings),
    cards: riskCardsFor(findings),
  };
}

export function formatRisk(result: RiskCheckResult): string {
  const lines = [`${String(result.filesChanged)} file(s) changed against ${result.base}`, ''];

  if (!result.requirement.required) {
    lines.push('✓ no high-risk surface touched — no security review required');
    return lines.join('\n');
  }

  lines.push(`⚠ security review REQUIRED — ${result.requirement.reason}`);
  lines.push(
    `  approver: one of ${result.requirement.roles.join(' / ')} (a human; an agent approval does not count)`,
  );
  lines.push('');
  for (const finding of result.findings) {
    lines.push(`  ${finding.surface}: ${finding.path} — ${finding.evidence}`);
  }
  lines.push('', `${String(result.cards.length)} risk card(s) to create:`);
  for (const card of result.cards) {
    lines.push(`  ${card.title} (${String(card.paths.length)} file(s))`);
  }
  return lines.join('\n');
}
