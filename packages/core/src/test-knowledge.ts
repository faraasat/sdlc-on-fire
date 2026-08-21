/**
 * The knowledge axis: white, grey and black box (P3-QA-08,
 * `.research/techniques/43` §2).
 *
 * {@link TEST_TIERS} classifies a test by **how much of the system it
 * exercises** — unit, integration, smoke, regression, e2e. It cannot express
 * **how much the test knew**, and the two are orthogonal: a unit test can be
 * written against a specification, and an e2e test can be written against the
 * implementation's internals.
 *
 * That gap matters here for one reason specific to agentic development. **The
 * agent that wrote the implementation writes tests about the implementation it
 * wrote.** A suite that is entirely white box, authored by the author, is a
 * self-consistency check wearing a test suite's clothes — it will be green on
 * an implementation that satisfies nothing anybody asked for, which is exactly
 * the gap SpecBench measures and [P3-GATE-09] made computable.
 *
 * **Declared, never inferred.** Whether a test is black box is a property of
 * *how it was produced*, not of its text: the same assertion is white box if
 * written by reading the function and black box if written by reading the spec.
 * Nothing in the file can tell them apart, so the marker is written by whatever
 * wrote the test, and a missing marker is not a puzzle to solve — it is an
 * answer.
 *
 * **The default is `white`, and that is the cautious direction.** An undeclared
 * test is assumed to have seen everything, because assuming otherwise would let
 * a policy requiring black-box coverage be satisfied by writing nothing down.
 */

export const TEST_KNOWLEDGE = ['white', 'grey', 'black'] as const;
export type TestKnowledge = (typeof TEST_KNOWLEDGE)[number];

/** The marker a test file carries, on a comment line in its header. */
export const KNOWLEDGE_MARKER = /@knowledge\s+(white|grey|gray|black)(?:[-\s]?box)?\b/i;

/** How far into the file the header is taken to extend. */
export const MARKER_SCAN_LINES = 40;

/**
 * Whether a line is a comment.
 *
 * The marker must sit on one, and that restriction was not in the first version
 * — which classified this module's *own test file* as black box, because a
 * fixture string containing `'// @knowledge black'` matched. Found by running
 * the command against this repository, not by a unit test, and it is the
 * ordinary case rather than a contrived one: any file that documents the marker
 * mentions it.
 */
function isCommentLine(line: string): boolean {
  const trimmed = line.trimStart();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

export interface KnowledgeDeclaration {
  readonly file: string;
  readonly knowledge: TestKnowledge;
  /** False when nothing was declared and the default applied. */
  readonly declared: boolean;
}

export function knowledgeOf(file: string, contents: string): KnowledgeDeclaration {
  const header = contents.split(/\r?\n/, MARKER_SCAN_LINES);
  const declaration = header
    .filter(isCommentLine)
    .map((line) => KNOWLEDGE_MARKER.exec(line))
    .find((match): match is RegExpExecArray => match !== null);

  if (declaration === undefined) return { file, knowledge: 'white', declared: false };

  const raw = (declaration[1] ?? 'white').toLowerCase();
  // `gray` and `grey` are the same thing and both get written.
  const knowledge: TestKnowledge = raw === 'gray' ? 'grey' : (raw as TestKnowledge);
  return { file, knowledge, declared: true };
}

export interface KnowledgePolicy {
  /** Minimum proportion of test files that must be black box, 0–1. */
  readonly minBlackBox: number;
  /** Whether an undeclared file is a finding in its own right. */
  readonly requireDeclaration: boolean;
}

export const DEFAULT_KNOWLEDGE_POLICY: KnowledgePolicy = {
  // Zero by default, and deliberately: a requirement nobody opted into would
  // make every existing project red on upgrade, and a check people turn off is
  // worse than one they turn on.
  minBlackBox: 0,
  requireDeclaration: false,
};

export interface KnowledgeMix {
  readonly counts: Readonly<Record<TestKnowledge, number>>;
  readonly total: number;
  readonly undeclared: number;
  /** Proportion of files declared black box, 0–1. `null` when there are none. */
  readonly blackBoxShare: number | null;
  readonly findings: readonly string[];
  readonly ok: boolean;
}

/**
 * The mix a suite actually has, against the mix a policy asks for.
 *
 * `blackBoxShare` is `null` rather than `0` for an empty suite, for the same
 * reason [P3-GATE-09]'s delta is: "no black-box tests" and "no tests" are
 * different states, and only one of them is about this axis.
 */
export function evaluateKnowledgeMix(
  declarations: readonly KnowledgeDeclaration[],
  policy: KnowledgePolicy = DEFAULT_KNOWLEDGE_POLICY,
): KnowledgeMix {
  const counts: Record<TestKnowledge, number> = { white: 0, grey: 0, black: 0 };
  for (const entry of declarations) counts[entry.knowledge] += 1;

  const total = declarations.length;
  const undeclared = declarations.filter((entry) => !entry.declared).length;
  const blackBoxShare = total === 0 ? null : counts.black / total;

  const findings: string[] = [];

  if (policy.requireDeclaration && undeclared > 0) {
    findings.push(
      `${String(undeclared)} of ${String(total)} test file(s) declare no \`@knowledge\` marker — ` +
        'an undeclared test counts as white box, because whether it saw the implementation is ' +
        'a fact about how it was written and nothing in the file can recover it',
    );
  }

  if (policy.minBlackBox > 0) {
    if (blackBoxShare === null) {
      findings.push('the policy asks for black-box coverage and there are no test files at all');
    } else if (blackBoxShare < policy.minBlackBox) {
      findings.push(
        `${String(Math.round(blackBoxShare * 100))}% of test files are black box, below the ` +
          `${String(Math.round(policy.minBlackBox * 100))}% this preset requires — a suite written ` +
          'entirely against the implementation agrees with the implementation',
      );
    }
  }

  return { counts, total, undeclared, blackBoxShare, findings, ok: findings.length === 0 };
}

export function formatKnowledgeMix(mix: KnowledgeMix): string {
  const lines = [
    `${String(mix.total)} test file(s): ${String(mix.counts.black)} black, ` +
      `${String(mix.counts.grey)} grey, ${String(mix.counts.white)} white` +
      `${mix.undeclared > 0 ? ` (${String(mix.undeclared)} undeclared)` : ''}`,
  ];

  if (mix.blackBoxShare !== null) {
    lines.push(`  black-box share: ${String(Math.round(mix.blackBoxShare * 100))}%`);
  }
  for (const finding of mix.findings) lines.push(`  ✗ ${finding}`);

  if (mix.counts.black === 0 && mix.total > 0) {
    lines.push(
      '',
      'No black-box tests. Every test here was written by somebody who could see',
      'the implementation, so the suite can only disagree with the code by accident.',
      'Mark a file with `@knowledge black` when it was written from the spec alone.',
    );
  }
  return lines.join('\n');
}
