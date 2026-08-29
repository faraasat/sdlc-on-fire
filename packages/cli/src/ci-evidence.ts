import os from 'node:os';
import {
  admitCheckRun,
  checkNames,
  computeConfidence,
  EvidenceEnvelopeSchema,
  formatAdmission,
  GITHUB_API,
  type CheckRun,
  type CiAdmission,
  type EvidenceEnvelope,
} from '@sdlc-on-fire/core';
import { applySchema } from '@sdlc-on-fire/db';
import { payloadHash, persistEvidence } from '@sdlc-on-fire/evidence';
import { openWorkspaceDatabase } from './commands.js';
import { resolveToken } from './tracker.js';

/**
 * `sdlc ci-evidence` — the CI half of the gate (P6-SURFACE-07, FEAT-EVID-007).
 *
 * `producer: 'ci'` has had a confidence weight and a place in `evaluateGate`
 * since contract 03 was written, and nothing ever wrote one. Teams with real CI
 * could not point this product at what they already run, so every gate here has
 * been fed by the local daemon alone.
 *
 * The check runs are **fetched by us**, from the provider, against a ref — never
 * accepted as a JSON blob somebody hands in. A status report supplied by the
 * thing being judged is self-report wearing a CI badge, and this repository's
 * first rule is that self-report is not evidence.
 */

/** GitHub's own header set, matching `github-issues.ts`. */
function headers(token: string): Record<string, string> {
  return {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'x-github-api-version': '2022-11-28',
  };
}

export class CheckFetchError extends Error {
  override readonly name = 'CheckFetchError';
  constructor(repo: string, ref: string, status: number, body: string) {
    super(
      `could not read check runs for ${repo}@${ref} — GitHub answered ${String(status)}. ${body.slice(0, 200)}`,
    );
  }
}

export type Fetcher = typeof globalThis.fetch;

/**
 * Every check run on a ref.
 *
 * `per_page=100` and a single page: a commit with more than a hundred check
 * runs is a repository whose CI shape this command cannot usefully summarise
 * anyway, and silently reading the first page while presenting it as "the
 * checks" would be the quiet truncation this codebase keeps finding. Over the
 * page, it says so.
 */
export async function fetchCheckRuns(
  repo: string,
  ref: string,
  token: string,
  fetcher: Fetcher = globalThis.fetch,
): Promise<{ readonly runs: readonly CheckRun[]; readonly truncated: boolean }> {
  const url = `${GITHUB_API}/repos/${repo}/commits/${encodeURIComponent(ref)}/check-runs?per_page=100`;
  const response = await fetcher(url, { headers: headers(token) });
  if (!response.ok) {
    throw new CheckFetchError(repo, ref, response.status, await response.text().catch(() => ''));
  }
  const body = (await response.json()) as {
    total_count?: number;
    check_runs?: readonly CheckRun[];
  };
  const runs = body.check_runs ?? [];
  return { runs, truncated: (body.total_count ?? runs.length) > runs.length };
}

export interface CiEvidenceResult {
  readonly repo: string;
  readonly ref: string;
  readonly check: string;
  readonly available: readonly string[];
  readonly truncated: boolean;
  readonly admission: CiAdmission;
  readonly envelope?: EvidenceEnvelope | undefined;
  /** The row id, when one was written. */
  readonly evidenceId?: number | undefined;
}

export interface CiEvidenceOptions {
  readonly repo: string;
  readonly ref: string;
  readonly check: string;
  readonly token?: string | undefined;
  readonly fetcher?: Fetcher | undefined;
  /** Persist the envelope. Absent, this reports what it would write. */
  readonly apply?: boolean | undefined;
  readonly now?: Date | undefined;
}

/**
 * Builds the envelope for an admitted check run.
 *
 * `git_sha` is the sha **the check ran on**, taken from the check run itself
 * rather than from the ref the caller asked about. They differ whenever a
 * branch moved after CI started, and that difference is the entire reason the
 * staleness machinery exists — copying the caller's ref in would defeat it by
 * making every envelope look current.
 */
export function ciEnvelope(
  admission: CiAdmission,
  now: Date = new Date(),
): EvidenceEnvelope | null {
  // `payload === undefined` alone: a refusal never carries one, so testing
  // `admitted` as well would be a second guard nothing can reach — and the
  // comment above `CiAdmission` is what keeps that true.
  const payload = admission.payload;
  if (payload === undefined) return null;

  const produced_at = now.toISOString();
  return EvidenceEnvelopeSchema.parse({
    kind: 'ci-status',
    producer: 'ci',
    git_sha: payload.head_sha,
    env: {
      tool_versions: { node: process.version },
      os: `${os.platform()}-${os.arch()}`,
    },
    content_hash: payloadHash(payload),
    confidence: computeConfidence({ producer: 'ci', produced_at }),
    produced_at,
    payload,
  });
}

export async function ciEvidence(
  root: string,
  options: CiEvidenceOptions,
): Promise<CiEvidenceResult> {
  const token = options.token ?? (await resolveToken());
  const { runs, truncated } = await fetchCheckRuns(
    options.repo,
    options.ref,
    token,
    options.fetcher,
  );

  const admission = admitCheckRun(runs, options.check);
  const envelope = ciEnvelope(admission, options.now);
  const base = {
    repo: options.repo,
    ref: options.ref,
    check: options.check,
    available: checkNames(runs),
    truncated,
    admission,
    ...(envelope === null ? {} : { envelope }),
  };

  if (envelope === null || options.apply !== true) return base;

  const { db } = await openWorkspaceDatabase(root);
  try {
    await applySchema(db);
    return { ...base, evidenceId: await persistEvidence(db, envelope) };
  } finally {
    await db.close();
  }
}

export function formatCiEvidence(result: CiEvidenceResult): string {
  const lines = [
    `${result.repo}@${result.ref} — check "${result.check}"`,
    '',
    formatAdmission(result.admission, result.check),
  ];
  if (result.truncated) {
    lines.push('', 'note: this ref has more than 100 check runs and only the first page was read.');
  }
  if (result.evidenceId !== undefined) {
    lines.push('', `recorded as evidence #${String(result.evidenceId)} (producer: ci)`);
  } else if (result.envelope !== undefined) {
    lines.push('', 'dry run — nothing was written. Re-run with --apply.');
  }
  return lines.join('\n');
}
