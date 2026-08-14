import fs from 'node:fs/promises';
import path from 'node:path';
import {
  evaluateProposal,
  formatProposalVerdict,
  mineTraces,
  relativePosix,
  resolveWorkspaceLayout,
  type ImprovementProposal,
  type MiningResult,
  type ProposalVerdict,
  type TraceRecord,
  type ValidationRun,
} from '@sdlc-on-fire/core';

/**
 * `sdlc improve` — the continuous-improvement loop's reachable surface
 * (P2-SKILL-04, ADR-0026).
 *
 * `mine` reads traces and reports recurring patterns. `review` judges the
 * proposals on disk against their validation runs. `approve` is the human step,
 * and it is a separate command on purpose — nothing in `mine` or `review` can
 * reach it, and no flag on either of them shortcuts it.
 *
 * The proposals live in the workspace as files rather than in the database, for
 * the same reason every other artifact does: content in git, state in the DB. A
 * proposal to change a prompt is a change proposal, and it should show up in a
 * diff where someone can argue with it.
 */

/** Where mined proposals and their validation runs live. */
export const IMPROVEMENTS_DIR = '_improvements';

export interface ImproveMineResult {
  readonly tracesRead: number;
  readonly result: MiningResult;
}

export interface ImproveReviewResult {
  readonly verdicts: readonly ProposalVerdict[];
  readonly productionTier: string;
  /** True only when every proposal is approved or rejected — nothing left waiting. */
  readonly settled: boolean;
}

const improvementsDir = (root: string): string =>
  path.join(resolveWorkspaceLayout(root).kanbanDir, IMPROVEMENTS_DIR);

/** One JSON file per proposal, alongside the validation run that judged it. */
interface StoredProposal {
  readonly proposal: ImprovementProposal;
  readonly validation?: ValidationRun | undefined;
  readonly approvals?: readonly { actorId: string; actorKind: 'human' | 'agent'; at: string }[];
}

async function readProposals(dir: string): Promise<{ file: string; stored: StoredProposal }[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const proposals: { file: string; stored: StoredProposal }[] = [];

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const raw = await fs.readFile(path.join(dir, entry.name), 'utf8').catch(() => null);
    if (raw === null) continue;
    try {
      proposals.push({ file: entry.name, stored: JSON.parse(raw) as StoredProposal });
    } catch {
      // A malformed proposal is skipped rather than aborting the review: one
      // bad file must not hide every other proposal waiting for a human.
    }
  }
  return proposals;
}

export async function mineImprovements(
  root: string,
  tracesPath: string,
): Promise<ImproveMineResult> {
  const layout = resolveWorkspaceLayout(root);
  const raw = await fs.readFile(path.join(layout.root, tracesPath), 'utf8').catch(() => null);
  if (raw === null) throw new Error(`no trace file at ${tracesPath}`);

  // JSONL, one trace per line — the shape a run log actually accumulates in.
  const traces: TraceRecord[] = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as TraceRecord);

  return { tracesRead: traces.length, result: mineTraces(traces) };
}

export async function reviewImprovements(
  root: string,
  productionTier: string,
): Promise<ImproveReviewResult> {
  const stored = await readProposals(improvementsDir(root));
  const verdicts = stored.map(({ stored: entry }) =>
    evaluateProposal(
      entry.proposal,
      entry.validation ?? null,
      productionTier,
      entry.approvals ?? [],
    ),
  );

  return {
    verdicts,
    productionTier,
    settled: verdicts.every(
      (verdict) => verdict.state === 'approved' || verdict.state === 'rejected',
    ),
  };
}

export interface ApproveResult {
  readonly id: string;
  readonly file: string;
  readonly verdict: ProposalVerdict;
}

/**
 * Records a human's approval on a proposal.
 *
 * `actorKind` is fixed to `human` here and is not a parameter, because this
 * command is the human step — an interface that accepted `--actor-kind agent`
 * would be an interface for skipping it. An agent driving this command is
 * lying about who it is, which is a different problem from a design that let it
 * through honestly.
 *
 * The approval is appended to the proposal file rather than replacing anything:
 * the mined evidence, the validation run and the approval are three separate
 * records of three separate acts, and a reviewer should see all of them.
 */
export async function approveImprovement(
  root: string,
  id: string,
  actorId: string,
  productionTier: string,
  now: () => string = () => new Date().toISOString(),
): Promise<ApproveResult> {
  const dir = improvementsDir(root);
  const stored = await readProposals(dir);
  const found = stored.find((entry) => entry.stored.proposal.id === id);
  if (found === undefined) throw new Error(`no improvement proposal with id "${id}" under ${dir}`);

  const approvals = [
    ...(found.stored.approvals ?? []),
    { actorId, actorKind: 'human' as const, at: now() },
  ];
  const next: StoredProposal = { ...found.stored, approvals };

  const verdict = evaluateProposal(
    next.proposal,
    next.validation ?? null,
    productionTier,
    approvals,
  );

  // Written even when the verdict is not `approved`. An approval that was
  // recorded and did not carry is a fact about the review, and dropping it
  // would let the same proposal be approved twice with nothing showing that the
  // first attempt was refused for a reason nobody fixed.
  await fs.writeFile(path.join(dir, found.file), `${JSON.stringify(next, null, 2)}\n`, 'utf8');

  return {
    id,
    file: relativePosix(resolveWorkspaceLayout(root).root, path.join(dir, found.file)),
    verdict,
  };
}

export function formatMining(result: ImproveMineResult): string {
  const lines = [`${String(result.tracesRead)} trace(s) read`];

  for (const refusal of result.result.refusals) lines.push('', `⚠ ${refusal}`);
  if (result.result.patterns.length === 0 && result.result.refusals.length === 0) {
    lines.push('', 'No pattern recurs often enough to propose a change from.');
    return lines.join('\n');
  }

  for (const pattern of result.result.patterns) {
    lines.push(
      '',
      `  ${pattern.signature}  ×${String(pattern.occurrences)}`,
      `    outcomes: ${pattern.outcomes.join(', ')}`,
      `    e.g. ${pattern.examples.join(', ')}`,
    );
  }

  lines.push(
    '',
    'These are patterns, not changes. A proposal is written from one, validated',
    'against a held-out suite, and merged by a person — there is no step here that',
    'applies anything (ADR-0026).',
  );
  return lines.join('\n');
}

export function formatReview(result: ImproveReviewResult): string {
  if (result.verdicts.length === 0) return 'no improvement proposals waiting.';

  const lines = [
    `${String(result.verdicts.length)} proposal(s), judged against production tier "${result.productionTier}"`,
    '',
    ...result.verdicts.map(formatProposalVerdict),
  ];

  const waiting = result.verdicts.filter((verdict) => verdict.state === 'validated');
  if (waiting.length > 0) {
    lines.push(
      '',
      `${String(waiting.length)} validated and waiting for a person:`,
      ...waiting.map((verdict) => `  sdlc improve approve ${verdict.id} --as <you>`),
    );
  }
  return lines.join('\n');
}
