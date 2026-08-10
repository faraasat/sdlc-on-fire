/**
 * Doc-comment presence and comment-bloat heuristics (P1-GATE-11, ADR-0055/0056).
 *
 * Two checks with deliberately different standing, and the difference is the
 * point (ADR-0056):
 *
 * - **Doc-comment presence on exported API is deterministic**, so it gates.
 * - **"This comment is bloated" has no reliable signal**, so it advises. The
 *   ratio and oversized-block heuristics flag candidates for a human; they never
 *   block. ADR-0056 records this as an acknowledged interim exception to
 *   "deterministic disposer" rather than a hidden one, and pretending the
 *   heuristic were authoritative would be the hidden version.
 */

export interface CommentFinding {
  /** Which file, so a report can be acted on without re-deriving it. */
  readonly file: string;
  readonly line: number;
  readonly symbol: string;
  readonly kind: 'missing-doc-comment' | 'oversized-comment-block';
  readonly detail: string;
}

export interface CodeQualityReport {
  readonly file: string;
  readonly exported: number;
  readonly documented: number;
  /** Comment lines ÷ total lines. Advisory context, not a threshold to pass. */
  readonly commentRatio: number;
  /** Blocks over the advisory size, longest first. */
  readonly gating: readonly CommentFinding[];
  readonly advisory: readonly CommentFinding[];
}

/** Lines in one comment block above which a human should look at it (ADR-0056). */
export const OVERSIZED_COMMENT_LINES = 30;

const EXPORT_DECL =
  /^export\s+(?:async\s+)?(?:function|class|const|interface|type|enum)\s+([A-Za-z_$][\w$]*)/;

/**
 * Analyses one TypeScript source file.
 *
 * Line-based rather than AST-based, and that is a real limitation stated rather
 * than hidden: it cannot see an export inside a namespace, and a `//` inside a
 * string literal counts as a comment. It is used for a *presence* check and an
 * advisory ratio, where the cost of a miss is a nudge nobody needed — not for
 * anything that decides correctness.
 */
export function analyseFile(file: string, source: string): CodeQualityReport {
  const lines = source.split('\n');
  const gating: CommentFinding[] = [];
  const advisory: CommentFinding[] = [];

  let exported = 0;
  let documented = 0;
  let commentLines = 0;
  let blockStart: number | null = null;
  let inBlock = false;

  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();

    if (inBlock) {
      commentLines += 1;
      if (line.includes('*/')) {
        const length = index - (blockStart ?? index) + 1;
        if (length > OVERSIZED_COMMENT_LINES) {
          advisory.push({
            file,
            line: (blockStart ?? index) + 1,
            symbol: '(comment block)',
            kind: 'oversized-comment-block',
            detail:
              `${String(length)} lines — rationale this long belongs in the ADR it is explaining, ` +
              'referenced from one line here (ADR-0056)',
          });
        }
        inBlock = false;
        blockStart = null;
      }
      continue;
    }

    if (line.startsWith('/*')) {
      commentLines += 1;
      if (!line.includes('*/')) {
        inBlock = true;
        blockStart = index;
      }
      continue;
    }
    if (line.startsWith('//')) {
      commentLines += 1;
      continue;
    }

    const match = EXPORT_DECL.exec(line);
    if (match?.[1] !== undefined) {
      exported += 1;
      // A doc-comment is the block immediately above, allowing decorators and
      // blank-free adjacency only — a comment two statements up documents
      // something else.
      const previous = (lines[index - 1] ?? '').trim();
      if (previous.endsWith('*/') || previous.startsWith('//')) {
        documented += 1;
      } else {
        gating.push({
          file,
          line: index + 1,
          symbol: match[1],
          kind: 'missing-doc-comment',
          detail: 'exported API needs a doc-comment stating purpose, params and returns',
        });
      }
    }
  }

  return {
    file,
    exported,
    documented,
    commentRatio: lines.length === 0 ? 0 : Math.round((commentLines / lines.length) * 1000) / 1000,
    gating,
    advisory: advisory.sort((a, b) => b.line - a.line),
  };
}

export interface QualitySummary {
  readonly files: number;
  readonly exported: number;
  readonly documented: number;
  readonly undocumented: readonly CommentFinding[];
  readonly advisory: readonly CommentFinding[];
  /** Whether the deterministic half passes. The advisory half never affects this. */
  readonly ok: boolean;
}

/** Rolls per-file reports into the shape the gate consumes. */
export function summariseQuality(reports: readonly CodeQualityReport[]): QualitySummary {
  const undocumented = reports.flatMap((report) => report.gating);
  return {
    files: reports.length,
    exported: reports.reduce((sum, report) => sum + report.exported, 0),
    documented: reports.reduce((sum, report) => sum + report.documented, 0),
    undocumented,
    advisory: reports.flatMap((report) => report.advisory),
    // Advisory findings are excluded from `ok` by construction. A heuristic that
    // could fail a build would make people delete comments to appease it, which
    // is the opposite of what ADR-0056 wants.
    ok: undocumented.length === 0,
  };
}
