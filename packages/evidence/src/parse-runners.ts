import { TestEvidenceSchema, type TestEvidence } from '@sdlc-on-fire/core';

/**
 * Reading test counts out of runners that do not emit Vitest/Jest JSON
 * (P1-GATE-01 hardening, from the v007 evaluation).
 *
 * This exists because of a specific, measured failure. The gate's strongest
 * signal is a parsed report — how many tests ran and how many passed — and until
 * now the only thing that produced one was the Vitest/Jest JSON reporter.
 * Everything else fell back to the exit code, which meant an honest `node --test`
 * run with eight passing tests and a fabricated `echo FAKE PASS && exit 0`
 * produced **identical** evidence: `0/0`, exit 0, `report: exit-code-only`.
 *
 * A blind evaluator noticed exactly that and pointed out its consequence: even a
 * careful human reading the pull request has no signal distinguishing honest work
 * from fraud, because both render the same table. The check that was supposed to
 * be the deterministic disposer had, for most real projects, silently degraded
 * into "the command exited 0".
 *
 * So the fix is not another rule. It is *seeing more* — parsers for the formats
 * real runners actually emit, so a real suite produces a real count and a no-op
 * cannot borrow its appearance.
 *
 * Formats here were read off actual runner output on 2026-08-10, not assumed.
 */

/** A parser that returns `null` when the output is not its format. */
type Attempt = (raw: string) => TestEvidence | null;

function evidence(
  runner: string,
  total: number,
  passed: number,
  failed: number,
  failures: TestEvidence['failures'] = [],
): TestEvidence {
  return TestEvidenceSchema.parse({
    runner,
    total,
    passed,
    failed,
    // Derived from the counts, never from a "success: true" the runner printed.
    // A runner that crashed mid-suite can still claim success; it cannot claim a
    // failure count of zero while reporting failures.
    ok: failed === 0 && total > 0,
    failures,
  });
}

/**
 * Node's built-in test runner, default reporter.
 *
 * Emits an information block prefixed with `ℹ`: `ℹ tests 3`, `ℹ pass 2`,
 * `ℹ fail 1`. Matched on the whole line so a test *named* "tests 5" cannot be
 * read as a summary.
 */
const nodeDefault: Attempt = (raw) => {
  const read = (key: string): number | null => {
    const match = new RegExp(`^\\s*ℹ\\s+${key}\\s+(\\d+)\\s*$`, 'm').exec(raw);
    return match?.[1] === undefined ? null : Number(match[1]);
  };
  const total = read('tests');
  const passed = read('pass');
  const failed = read('fail');
  if (total === null || passed === null || failed === null) return null;
  return evidence('node --test', total, passed, failed);
};

/**
 * TAP, in both the shapes that matter.
 *
 * Node's `--test-reporter=tap` prints a `# tests N` summary block; the older TAP
 * convention is a `1..N` plan with `ok`/`not ok` lines. The summary is preferred
 * when present because it is the runner's own count; the plan is counted only as
 * a fallback, since counting `ok` lines misreads a subtest that prints its own.
 */
const tap: Attempt = (raw) => {
  const read = (key: string): number | null => {
    const match = new RegExp(`^#\\s+${key}\\s+(\\d+)\\s*$`, 'm').exec(raw);
    return match?.[1] === undefined ? null : Number(match[1]);
  };
  const total = read('tests');
  const passed = read('pass');
  const failed = read('fail');
  if (total !== null && passed !== null && failed !== null) {
    return evidence('tap', total, passed, failed);
  }

  if (!/^1\.\.\d+\s*$/m.test(raw)) return null;
  const plan = /^1\.\.(\d+)\s*$/m.exec(raw);
  const planned = plan?.[1] === undefined ? 0 : Number(plan[1]);
  if (planned === 0) return null;
  const notOk = (raw.match(/^not ok\b/gm) ?? []).length;
  return evidence('tap', planned, planned - notOk, notOk);
};

/**
 * pytest's summary line: `=== 3 passed, 1 failed in 0.12s ===`.
 *
 * Included because "it's a Node tool" is not a reason to be blind to the runner
 * a polyglot repository actually uses — and a repository whose tests we cannot
 * count is one where the gate quietly weakens.
 */
const pytest: Attempt = (raw) => {
  if (!/={3,}.*\b(passed|failed|error)\b.*={3,}/.test(raw)) return null;
  const count = (word: string): number => {
    const match = new RegExp(`(\\d+)\\s+${word}`).exec(raw);
    return match?.[1] === undefined ? 0 : Number(match[1]);
  };
  const passed = count('passed');
  const failed = count('failed') + count('error');
  if (passed + failed === 0) return null;
  return evidence('pytest', passed + failed, passed, failed);
};

/** `go test`: counts `--- PASS:` / `--- FAIL:` lines. */
const goTest: Attempt = (raw) => {
  const passed = (raw.match(/^\s*--- PASS:/gm) ?? []).length;
  const failed = (raw.match(/^\s*--- FAIL:/gm) ?? []).length;
  if (passed + failed === 0) return null;
  return evidence('go test', passed + failed, passed, failed);
};

const ATTEMPTS: readonly Attempt[] = [nodeDefault, tap, pytest, goTest];

/**
 * Reads a test count out of whatever the runner printed, or returns `null`.
 *
 * `null` is a real answer and is reported as `exit-code-only` upstream rather
 * than being papered over with a guess. The point of this module is to make that
 * answer *rarer*, not to pretend it never happens — inventing a count would be
 * far worse than admitting we could not read one.
 */
export function parseRunnerOutput(raw: string): TestEvidence | null {
  for (const attempt of ATTEMPTS) {
    try {
      const parsed = attempt(raw);
      if (parsed !== null) return parsed;
    } catch {
      // A parser that throws on unfamiliar input has simply declined; the next
      // one gets a turn. Only an exhausted list means "unreadable".
    }
  }
  return null;
}
