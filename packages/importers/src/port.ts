import type { IrNode } from './ir.js';

/**
 * The parser port (P2-IMP-01, `.research/10 §3`).
 *
 * Ports never import adapters ([ADR-0047](docs/.plan/decisions/ADR-0047-storage-port-db-ui-decoupling.md)),
 * so this file knows nothing about GSD, Spec Kit, OpenSpec or BMAD. Each of
 * those is a separate task precisely so a tool's next breaking rewrite costs one
 * file.
 */

export type DetectionConfidence = 'high' | 'medium' | 'low';

export interface DetectionResult {
  readonly toolId: string;
  readonly dialect: string;
  readonly matched: boolean;
  /**
   * Shape-sniffed, not merely marker-file presence.
   *
   * A `.gsd/` directory says someone once ran GSD; it does not say the contents
   * still parse as GSD. Confidence separates "this marker exists" from "this
   * content is what the marker claims", and a low-confidence parse is flagged
   * for human review rather than written silently.
   */
  readonly confidence: DetectionConfidence;
  /** Which files or shapes triggered the match — a claim with its reasons attached. */
  readonly evidence: readonly string[];
}

export interface ParseWarning {
  readonly file: string;
  readonly message: string;
}

export interface ParseResult {
  readonly items: readonly IrNode[];
  /** Per-file problems. A warning is a survivable defect, not a failed import. */
  readonly warnings: readonly ParseWarning[];
  readonly skippedFiles: readonly string[];
}

/**
 * One tool, one dialect.
 *
 * **Best-effort by contract.** `parse` must not throw past a single file: one
 * malformed card in a repository of four hundred cannot be allowed to abort the
 * migration, because the person running it has no way to know which file did it
 * and the tool has every way to say so. Skip, warn, keep going.
 */
export interface ToolParser {
  readonly toolId: string;
  readonly dialect: string;
  detect(rootPath: string): Promise<DetectionResult>;
  parse(rootPath: string): Promise<ParseResult>;
}

/**
 * Runs every parser's `detect` and reports **all** matches.
 *
 * Not just the winner. A repository mid-migration runs two tools at once, and
 * that is an ordinary state rather than an edge case (`.research/10 §3`) —
 * reporting only the highest-confidence match would hide half of what a user
 * needs to decide about.
 */
export async function detectAll(
  parsers: readonly ToolParser[],
  rootPath: string,
): Promise<readonly DetectionResult[]> {
  const results = await Promise.all(
    parsers.map(async (parser) => {
      try {
        return await parser.detect(rootPath);
      } catch (cause) {
        // A parser that throws during detection has declined, loudly enough to
        // record. It must not take the other parsers' answers down with it.
        return {
          toolId: parser.toolId,
          dialect: parser.dialect,
          matched: false,
          confidence: 'low' as const,
          evidence: [`detect failed: ${String(cause)}`],
        };
      }
    }),
  );
  return results.filter((result) => result.matched);
}
