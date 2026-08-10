import {
  detectAll,
  OpenSpecParser,
  SpecKitParser,
  type DetectionResult,
  type ToolParser,
} from '@sdlc-on-fire/importers';

/**
 * `sdlc detect` (P2-IMP-02, `.research/10 §3`).
 *
 * **Reports every match, not the winner.** A repository part-way through a
 * migration runs two tools at once, and that is an ordinary state rather than an
 * edge case. Showing only the highest-confidence match would hide half of what
 * the person deciding needs to see, and the half it hides is precisely the one
 * they did not expect to still be there.
 *
 * **Confidence is shape-sniffed and its reasons travel with it.** A marker
 * directory says someone once ran a tool; it does not say the contents still
 * parse as that tool's format. A bare `medium` with no evidence attached is a
 * verdict nobody can check, so every result carries the files and shapes that
 * produced it.
 */

/** Every parser the build knows about. Grows one entry per P2-IMP-0{3..6}. */
export const ALL_PARSERS: readonly ToolParser[] = [new OpenSpecParser(), new SpecKitParser()];

export interface DetectResult {
  readonly root: string;
  readonly matches: readonly DetectionResult[];
  /** True when more than one tool matched — a coexisting, mid-migration repo. */
  readonly coexisting: boolean;
}

export async function detectTools(
  root: string,
  parsers: readonly ToolParser[] = ALL_PARSERS,
): Promise<DetectResult> {
  const matches = await detectAll(parsers, root);
  return { root, matches: [...matches], coexisting: matches.length > 1 };
}

const ORDER: Record<DetectionResult['confidence'], number> = { high: 0, medium: 1, low: 2 };

export function formatDetect(result: DetectResult): string {
  if (result.matches.length === 0) {
    return [
      'No supported source format found.',
      '',
      `Looked for: ${ALL_PARSERS.map((p) => `${p.toolId}/${p.dialect}`).join(', ')}.`,
      'Nothing to import — this is a normal answer for a project that never used one of them.',
    ].join('\n');
  }

  const sorted = [...result.matches].sort((a, b) => ORDER[a.confidence] - ORDER[b.confidence]);
  const lines = [`${String(sorted.length)} source format(s) found in ${result.root}:`, ''];

  for (const match of sorted) {
    lines.push(`  ${match.toolId}/${match.dialect}  —  confidence: ${match.confidence}`);
    for (const evidence of match.evidence) lines.push(`      ${evidence}`);
    if (match.confidence !== 'high') {
      // Named at the point of doubt rather than in a footnote. A medium-
      // confidence parse that gets imported unreviewed is how a migration
      // quietly mangles a repository.
      lines.push('      ⚠ review a dry-run before importing this one');
    }
    lines.push('');
  }

  if (result.coexisting) {
    lines.push(
      'More than one tool matched. That is normal for a repo mid-migration —',
      'import them one at a time and check the report between runs.',
    );
  }
  return lines.join('\n').trimEnd();
}
