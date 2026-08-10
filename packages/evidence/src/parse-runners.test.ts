import { describe, expect, it } from 'vitest';
import { parseRunnerOutput } from './parse-runners.js';

/**
 * Reading real runner output (from the v007 evaluation).
 *
 * Every fixture here is output actually printed by the runner it names, captured
 * on 2026-08-10 — not a hand-written approximation. The bug this closes was
 * precisely an assumption about output format going unchecked: because nothing
 * parsed `node --test`, an honest eight-test suite and `echo PASS && exit 0`
 * produced identical evidence, and a human reading the PR could not tell them
 * apart.
 */

const NODE_DEFAULT = `✔ one (0.602041ms)
✔ two (0.093666ms)
ℹ tests 3
ℹ suites 0
ℹ pass 2
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 47.190708`;

const NODE_TAP = `# tests 3
# suites 0
# pass 2
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 33.055792`;

describe('node --test', () => {
  it('reads the counts from the default reporter', () => {
    const parsed = parseRunnerOutput(NODE_DEFAULT);
    expect(parsed?.total).toBe(3);
    expect(parsed?.passed).toBe(2);
    expect(parsed?.failed).toBe(1);
    expect(parsed?.ok).toBe(false);
  });

  it('reads the TAP reporter too', () => {
    const parsed = parseRunnerOutput(NODE_TAP);
    expect(parsed?.total).toBe(3);
    expect(parsed?.failed).toBe(1);
  });

  it('derives ok from the counts, not from anything the runner asserted', () => {
    // A runner that crashed mid-suite can still print a success banner; it
    // cannot print a failure count of zero while reporting failures.
    const green = parseRunnerOutput(NODE_DEFAULT.replace('ℹ fail 1', 'ℹ fail 0'));
    expect(green?.ok).toBe(true);
  });

  it('is not fooled by a test named like a summary line', () => {
    // Matched on the whole line, so `✔ tests 5` cannot be read as a count.
    const parsed = parseRunnerOutput(`✔ tests 5 (1ms)\nℹ tests 1\nℹ pass 1\nℹ fail 0`);
    expect(parsed?.total).toBe(1);
  });
});

describe('other runners', () => {
  it('reads a pytest summary', () => {
    const parsed = parseRunnerOutput('===== 3 passed, 1 failed in 0.12s =====');
    expect(parsed?.total).toBe(4);
    expect(parsed?.failed).toBe(1);
  });

  it('counts go test results', () => {
    const parsed = parseRunnerOutput('--- PASS: TestA (0.00s)\n--- FAIL: TestB (0.01s)\nFAIL');
    expect(parsed?.total).toBe(2);
    expect(parsed?.passed).toBe(1);
  });

  it('counts a TAP plan when there is no summary block', () => {
    const parsed = parseRunnerOutput('1..3\nok 1 a\nnot ok 2 b\nok 3 c');
    expect(parsed?.total).toBe(3);
    expect(parsed?.failed).toBe(1);
  });
});

describe('what it refuses to read', () => {
  it('returns null for a command that ran no tests', () => {
    // The whole attack: a command that exits 0 having run nothing must not be
    // able to borrow the appearance of a passing suite.
    expect(parseRunnerOutput('FAKE PASS')).toBeNull();
    expect(parseRunnerOutput('')).toBeNull();
  });

  it('returns null rather than guessing a count from prose', () => {
    // Inventing a number would be far worse than admitting we could not read
    // one — an unread check is reported as unread upstream.
    expect(parseRunnerOutput('All tests passed successfully!')).toBeNull();
    expect(parseRunnerOutput('Everything looks good, 5 things were fine')).toBeNull();
  });

  it('refuses a zero-test TAP plan', () => {
    expect(parseRunnerOutput('1..0')).toBeNull();
  });
});
