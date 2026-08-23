import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  detectRiskSurfaces,
  detectUiSurface,
  situationsFromDiff,
  type ChangedFile,
  type SkillSituation,
  type SurfaceFinding,
} from '@sdlc-on-fire/core';
import { skillForSituation } from '@sdlc-on-fire/agent-manager';
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

export const defaultGit =
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

/** A situation this diff puts the change in, and the skill that answers it. */
export interface ApplicableSituation {
  readonly situation: SkillSituation;
  /** `null` when the situation is detected and no skill claims it — worth saying. */
  readonly skill: string | null;
}

export interface RiskCheckResult {
  readonly base: string;
  readonly filesChanged: number;
  readonly findings: readonly SurfaceFinding[];
  readonly requirement: SecurityReviewRequirement;
  readonly cards: readonly RiskCard[];
  /** UI files touched. Not a risk surface; a reason to look before planning. */
  readonly uiPaths: readonly string[];
  /**
   * The situational skills this diff calls for (P6-PAYLOAD-05).
   *
   * `skillForSituation` had **no production caller**. Five situational skills
   * were written, registered and compiled to six targets, and nothing ever asked
   * which of them applied — the sixth read path with no writer this phase, and
   * the same symptom every time: not an error, silence. This is the first thing
   * that asks.
   */
  readonly situations: readonly ApplicableSituation[];
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
    uiPaths: detectUiSurface(files.map((file) => file.path)),
    situations: situationsFromDiff(files).map((situation) => ({
      situation,
      skill: skillForSituation(situation)?.name ?? null,
    })),
  };
}

/**
 * The situational skills, rendered after the risk verdict.
 *
 * Reported even when nothing is required: `touches-ui` on its own is not a
 * warning, and printing it only beside a security failure would make an ordinary
 * UI change look like one.
 */
function situationLines(result: RiskCheckResult): readonly string[] {
  if (result.situations.length === 0) return [];
  const lines = ['', 'situational skills that apply here:'];
  for (const applicable of result.situations) {
    lines.push(
      applicable.skill === null
        ? `  ${applicable.situation}: no skill claims this situation`
        : `  ${applicable.situation} → \`${applicable.skill}\``,
    );
  }
  return lines;
}

export function formatRisk(result: RiskCheckResult): string {
  const lines = [`${String(result.filesChanged)} file(s) changed against ${result.base}`, ''];

  if (!result.requirement.required) {
    lines.push('✓ no high-risk surface touched — no security review required');
    return [...lines, ...situationLines(result)].join('\n');
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
  return [...lines, ...situationLines(result)].join('\n');
}
