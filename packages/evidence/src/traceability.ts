/**
 * The traceability graph (P1-GATE-08, ADR-0032).
 *
 * The Evidence Engine already produces every fact an edge needs: test results,
 * the commit under test, and — since P1-GATE-04 — claim/citation records. What
 * it never did was keep them *connected*. After a gate verdict the connective
 * tissue was discarded, so "which requirement does this code satisfy, and what
 * proves it" was answerable only by re-running the gate or reconstructing
 * history by hand. This is retention, not a new pipeline.
 *
 * **Population is asynchronous** (ADR-0032). The gate's verdict does not wait
 * for the graph, and a failure to record an edge never fails a gate: a graph
 * that can block a passing build has turned an audit artifact into a
 * dependency. The cost is a brief window where evidence exists and is not yet
 * queryable, which is the tradeoff the ADR takes deliberately.
 */

export type EdgeOrigin = 'gate-evaluation' | 'claim-verification' | 'manual';

export interface TraceabilityEdge {
  readonly workItemId: string;
  /** The requirement end. */
  readonly acId?: string | undefined;
  readonly specId?: string | undefined;
  readonly changeId?: string | undefined;
  /** The implementation end. */
  readonly commitSha?: string | undefined;
  readonly filePath?: string | undefined;
  /** The proof end. */
  readonly testId?: string | undefined;
  readonly evidenceId?: number | undefined;
  readonly origin: EdgeOrigin;
}

export interface EdgeSink {
  query: <T>(sql: string, params?: unknown[]) => Promise<T[]>;
}

/**
 * Derives the edges one gate evaluation implies.
 *
 * Pure, so what gets written is testable without a database, and so the same
 * inputs always produce the same graph. Every edge here is a fact the run
 * already established — nothing is inferred about coverage that the evidence
 * did not state.
 */
export function edgesFromGateRun(input: {
  readonly workItemId: string;
  readonly commitSha?: string | undefined;
  readonly evidenceId?: number | undefined;
  /** Acceptance criteria the card declares. */
  readonly acceptanceCriteria?: readonly string[] | undefined;
  /** Files the run reported touching. */
  readonly filesChanged?: readonly string[] | undefined;
  /** Test identifiers the runner reported. */
  readonly testIds?: readonly string[] | undefined;
  readonly specId?: string | undefined;
}): readonly TraceabilityEdge[] {
  const edges: TraceabilityEdge[] = [];
  const criteria = input.acceptanceCriteria ?? [];
  const files = input.filesChanged ?? [];
  const tests = input.testIds ?? [];

  const base = {
    workItemId: input.workItemId,
    origin: 'gate-evaluation' as const,
    ...(input.commitSha === undefined ? {} : { commitSha: input.commitSha }),
    ...(input.evidenceId === undefined ? {} : { evidenceId: input.evidenceId }),
    ...(input.specId === undefined ? {} : { specId: input.specId }),
  };

  // The cross product is *not* taken. "Every criterion is satisfied by every
  // file" is not a fact the run established; it is a shape that would make
  // coverage look complete on any evidence at all. Each end is recorded
  // separately and joined through the shared evidence id — which is the only
  // link the run actually proved.
  if (criteria.length === 0 && files.length === 0 && tests.length === 0) {
    // Evidence with no other end is still worth keeping: it is the proof half of
    // an edge whose requirement half nobody has linked yet.
    return input.evidenceId === undefined ? [] : [base];
  }

  for (const acId of criteria) edges.push({ ...base, acId });
  for (const filePath of files) edges.push({ ...base, filePath });
  for (const testId of tests) edges.push({ ...base, testId });
  return edges;
}

/** Edges implied by a knowledge-claim verification: a claim, and what it cited. */
export function edgesFromClaims(input: {
  readonly workItemId: string;
  readonly evidenceId?: number | undefined;
  readonly commitSha?: string | undefined;
  readonly results: readonly {
    readonly claim: string;
    readonly citedChunkId: string | null;
    readonly verdict: string;
  }[];
}): readonly TraceabilityEdge[] {
  return (
    input.results
      // Only supported claims become edges. An unsupported or abstained claim is
      // precisely the case where nothing was established, and recording it would
      // let coverage be raised by asserting things nobody verified.
      .filter((result) => result.verdict === 'supported' && result.citedChunkId !== null)
      .map((result) => ({
        workItemId: input.workItemId,
        acId: result.claim,
        // The chunk id is `<path>#<index>`; the path is the file end of the edge.
        filePath: (result.citedChunkId ?? '').split('#')[0],
        origin: 'claim-verification' as const,
        ...(input.evidenceId === undefined ? {} : { evidenceId: input.evidenceId }),
        ...(input.commitSha === undefined ? {} : { commitSha: input.commitSha }),
      }))
  );
}

/**
 * Writes edges, never throwing.
 *
 * Returns how many landed. A failure here must not fail a gate — the graph is an
 * audit artifact, and one that can block a passing build has stopped being an
 * artifact and become a dependency. The count is returned so a caller that cares
 * can notice the shortfall rather than being told nothing happened.
 */
export async function recordEdges(
  db: EdgeSink,
  edges: readonly TraceabilityEdge[],
): Promise<{ written: number; failed: number }> {
  let written = 0;
  let failed = 0;
  for (const edge of edges) {
    try {
      // One row per link, with the *latest* proof attached. Re-running a suite
      // must not multiply the graph — that would make coverage climb every time
      // someone re-ran a test — and it must not leave the old evidence in place
      // either, since "covered" means covered by current tests against the
      // current implementation, not covered once by something.
      await db.query(
        `INSERT INTO traceability_edges
           (work_item_id, ac_id, spec_id, change_id, commit_sha, file_path, test_id, evidence_id, origin)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (work_item_id, COALESCE(ac_id,''), COALESCE(file_path,''),
                      COALESCE(test_id,''), origin)
         DO UPDATE SET evidence_id = EXCLUDED.evidence_id,
                       commit_sha  = EXCLUDED.commit_sha,
                       created_at  = now();`,
        [
          edge.workItemId,
          edge.acId ?? null,
          edge.specId ?? null,
          edge.changeId ?? null,
          edge.commitSha ?? null,
          edge.filePath ?? null,
          edge.testId ?? null,
          edge.evidenceId ?? null,
          edge.origin,
        ],
      );
      written += 1;
    } catch {
      failed += 1;
    }
  }
  return { written, failed };
}

export interface CoverageRow {
  readonly acId: string;
  readonly edges: number;
  readonly hasEvidence: boolean;
}

/**
 * Which criteria are connected to something, and which are not.
 *
 * The standing query ADR-0032 exists to make possible. "Covered" means
 * *connected to evidence* — a criterion with edges but no evidence id is linked
 * to code nobody proved anything about, which is a different and more
 * interesting state than being unlinked.
 */
export async function coverageFor(db: EdgeSink, workItemId: string): Promise<CoverageRow[]> {
  const rows = await db.query<{
    ac_id: string;
    edges: string | number;
    with_evidence: string | number;
  }>(
    `SELECT ac_id,
            count(*)                                        AS edges,
            count(*) FILTER (WHERE evidence_id IS NOT NULL) AS with_evidence
       FROM traceability_edges
      WHERE work_item_id = $1 AND ac_id IS NOT NULL
      GROUP BY ac_id
      ORDER BY ac_id;`,
    [workItemId],
  );
  return rows.map((row) => ({
    acId: row.ac_id,
    edges: Number(row.edges),
    hasEvidence: Number(row.with_evidence) > 0,
  }));
}
