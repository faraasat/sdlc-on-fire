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

/**
 * JUnit XML — the format most CI systems and most non-JS runners emit
 * (P8-EVID-01, [Q-04]).
 *
 * The last leg of Q-04, which assigned pytest, `go test` and JUnit-XML to v0.2
 * behind the common `TestEvidence` interface. The first two shipped; this one
 * did not, so every runner that speaks XML — Maven and Gradle, .NET, PHPUnit,
 * Ruby, `cargo nextest`, pytest under `--junitxml`, and every CI system that
 * ingests test results — fell through to exit-code-only. That is precisely the
 * degradation this module was written to stop: an honest suite and
 * `echo FAKE && exit 0` producing identical evidence.
 *
 * ## Counted from the elements, never from the attributes
 *
 * `<testsuite>` carries `tests`, `failures`, `errors` and `skipped`, and this
 * parser ignores all four. They are the producer's *claim* about its own run —
 * the same category of thing as a `success: true` flag, and the module already
 * refuses those. Counting `<testcase>` elements and classifying each by its
 * children is the deterministic disposer, and it is also what the format's own
 * definition says: **"A test passed if there isn't an additional result element
 * underneath it."**
 *
 * It also fixes a real disagreement between producers. `<testsuites>` may
 * aggregate its children's counts or may not, so a parser that trusts the
 * attributes either double-counts or under-counts depending on whose XML it was
 * handed.
 *
 * ## Three traps this handles on purpose
 *
 * **`errors` are not `failures`.** A suite reporting `failures="0" errors="3"`
 * has three tests that never ran to a verdict, and a parser reading only
 * `failures` calls that green. Both are counted as failed here, because a test
 * that crashed did not pass.
 *
 * **`tests` includes skipped.** So `passed` cannot be `tests - failures`;
 * a suite of 10 with 8 skipped and 2 passing is not 10 passing. Skips are
 * counted out of both `total` and `passed`, which makes `total` the number of
 * tests that actually produced a verdict — the number a gate should be reading.
 *
 * **CDATA can legally contain `<testcase`.** Failure messages carry stack
 * traces, and inside `<![CDATA[…]]>` the angle brackets are not escaped. A scan
 * that did not strip CDATA first would count a stack trace as a test. Comments
 * are stripped for the same reason.
 *
 * Format facts checked 2026-08-31 against the community reference schema
 * (`testmoapp/junitxml`) — tier B, cited because there is no vendor: JUnit XML
 * is a de-facto format with no single owner, and saying so is more honest than
 * implying a specification exists.
 */
const junitXml: Attempt = (raw) => {
  if (!/<testsuites?\b/i.test(raw)) return null;

  // Strip what may legally contain raw `<`. Order matters: a comment can
  // contain the literal text `<![CDATA[`, so comments go first.
  const text = raw.replace(/<!--[\s\S]*?-->/g, '').replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '');

  const failures: { file: string; title: string; message: string }[] = [];
  let passed = 0;
  let failed = 0;
  let skipped = 0;

  // Walk `<testcase` occurrences rather than splitting, so a self-closing case
  // and a case with a body are distinguished by what actually follows the tag.
  // `[^>]*?` is lazy on purpose: a greedy class swallows the `/` of a
  // self-closing tag, so every `<testcase … />` reads as an open tag with no
  // close, and the whole document is declined as truncated. Caught by the
  // passing-suite test, which is the plainest input this parser has.
  const open = /<testcase\b([^>]*?)(\/?)>/gi;
  let match: RegExpExecArray | null;
  while ((match = open.exec(text)) !== null) {
    const attributes = match[1] ?? '';
    const selfClosing = match[2] === '/';

    // A self-closing testcase has no result element under it, so it passed.
    let body = '';
    if (!selfClosing) {
      const close = text.indexOf('</testcase>', open.lastIndex);
      // No closing tag means the document was truncated. Declining the whole
      // file is right: a partial count reported as a total is the failure this
      // parser exists to prevent, dressed as a success.
      if (close === -1) return null;
      body = text.slice(open.lastIndex, close);
    }

    if (/<(failure|error)\b/i.test(body)) {
      failed += 1;
      const name = /\bname\s*=\s*"([^"]*)"/i.exec(attributes)?.[1] ?? '';
      const classname = /\bclassname\s*=\s*"([^"]*)"/i.exec(attributes)?.[1] ?? '';
      const message = /<(?:failure|error)\b[^>]*\bmessage\s*=\s*"([^"]*)"/i.exec(body)?.[1] ?? '';
      failures.push({ file: classname, title: name, message });
    } else if (/<skipped\b/i.test(body)) {
      skipped += 1;
    } else {
      passed += 1;
    }
  }

  // A `<testsuites>` wrapper with no cases at all is not this format declining
  // — it is a report of an empty run, and `evidence()` renders that as `ok:
  // false` rather than a vacuous pass. But a document with no `<testcase` at
  // all and no counts is more likely something else that happens to mention
  // testsuites, so it declines.
  if (passed + failed + skipped === 0 && !/<testsuite\b/i.test(text)) return null;

  return evidence('junit-xml', passed + failed, passed, failed, failures);
};

const ATTEMPTS: readonly Attempt[] = [nodeDefault, tap, pytest, goTest, junitXml];

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
