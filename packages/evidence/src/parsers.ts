import {
  canonicalJsonHash,
  type BuildEvidence,
  type TestEvidence,
  type TypecheckEvidence,
} from '@sdlc-on-fire/core';

/**
 * Evidence parsers (contracts/03 §3).
 *
 * v0.1 ships three kinds — `test`, `typecheck`, `build` — for the TypeScript
 * toolchain only (mvp-slice). Every parser turns **raw command output** into a
 * typed payload. Nothing here asks an agent what happened; the daemon runs the
 * command and this reads what it printed (architecture §5).
 *
 * A parser that cannot understand its input **throws**. Returning a
 * plausible-looking empty result would manufacture evidence that a run
 * succeeded when nobody knows whether it did — the precise failure the evidence
 * gate exists to prevent.
 */

export class ParseError extends Error {
  override readonly name = 'ParseError';
  constructor(
    readonly parser: string,
    message: string,
  ) {
    super(`${parser}: ${message}`);
  }
}

interface VitestJsonAssertion {
  title?: string;
  fullName?: string;
  status?: string;
  failureMessages?: string[];
}

interface VitestJsonTestResult {
  name?: string;
  assertionResults?: VitestJsonAssertion[];
}

interface VitestJson {
  numTotalTests?: number;
  numPassedTests?: number;
  numFailedTests?: number;
  success?: boolean;
  testResults?: VitestJsonTestResult[];
}

/**
 * Parses `vitest --reporter=json` (and Jest's, which shares the shape).
 *
 * `ok` is derived from the failure count rather than trusting the reporter's own
 * `success` flag: a runner that crashed mid-suite can report `success: true`
 * having executed nothing.
 */
export function parseVitestJson(raw: string): TestEvidence {
  let parsed: VitestJson;
  try {
    parsed = JSON.parse(raw) as VitestJson;
  } catch (cause) {
    throw new ParseError('vitest-json', `output is not valid JSON (${(cause as Error).message})`);
  }

  if (typeof parsed.numTotalTests !== 'number') {
    throw new ParseError(
      'vitest-json',
      'missing numTotalTests — is this a vitest/jest JSON report?',
    );
  }

  const failures = (parsed.testResults ?? []).flatMap((file) =>
    (file.assertionResults ?? [])
      .filter((assertion) => assertion.status === 'failed')
      .map((assertion) => ({
        file: file.name ?? '',
        title: assertion.fullName ?? assertion.title ?? '',
        message: (assertion.failureMessages ?? []).join('\n'),
      })),
  );

  const total = parsed.numTotalTests;
  const failed = parsed.numFailedTests ?? failures.length;
  const passed = parsed.numPassedTests ?? total - failed;

  return {
    runner: 'vitest',
    total,
    passed,
    failed,
    // A zero-test run is not a pass. "Nothing ran" and "everything passed" are
    // different facts, and only one of them is evidence.
    ok: failed === 0 && total > 0,
    failures,
  };
}

const TSC_ERROR = /^(.+?)\((\d+),\d+\):\s+error\s+TS\d+:\s+(.*)$/;

/**
 * Parses `tsc` diagnostic output.
 *
 * Text rather than JSON because `tsc` has no stable JSON reporter; the
 * `file(line,col): error TSxxxx:` shape is the documented one.
 */
export function parseTscOutput(raw: string, exitCode: number): TypecheckEvidence {
  const errors = raw
    .split('\n')
    .map((line) => TSC_ERROR.exec(line.trim()))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({
      file: match[1] ?? '',
      line: Number.parseInt(match[2] ?? '0', 10),
      message: match[3] ?? '',
    }));

  // Exit code is authoritative. A non-zero exit with no parseable diagnostic
  // still means the typecheck failed — most likely a crash, which is worse than
  // a type error, not better.
  return {
    tool: 'tsc',
    ok: exitCode === 0,
    errorCount: errors.length > 0 ? errors.length : exitCode === 0 ? 0 : 1,
    errors,
  };
}

/** Build evidence is exit-code shaped: it either produced artifacts or it did not. */
export function parseBuildResult(input: {
  cmd: string;
  exitCode: number;
  durationMs: number;
}): BuildEvidence {
  if (!Number.isFinite(input.durationMs) || input.durationMs < 0) {
    throw new ParseError('build', `implausible durationMs: ${input.durationMs}`);
  }
  return {
    cmd: input.cmd,
    exit_code: input.exitCode,
    ok: input.exitCode === 0,
    durationMs: input.durationMs,
  };
}

/**
 * Content hash for an evidence payload.
 *
 * Canonical-JSON based, so two structurally equal payloads hash equal regardless
 * of key order — which is what makes the hash a stable content address rather
 * than an artifact of serialization.
 */
export function payloadHash(payload: unknown): string {
  return canonicalJsonHash(payload);
}
