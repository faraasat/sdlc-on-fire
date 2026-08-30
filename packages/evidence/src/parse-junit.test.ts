import { describe, expect, it } from 'vitest';
import { parseRunnerOutput } from './parse-runners.js';

/**
 * JUnit XML (P8-EVID-01, Q-04).
 *
 * Format facts checked 2026-08-31 against the community reference schema
 * (`testmoapp/junitxml`) — tier B, cited as such because JUnit XML has no
 * vendor and no single specification, and pretending otherwise would be a
 * fabricated authority.
 *
 * Every test here names the wrong answer it prevents. The dangerous failures
 * for this parser are all in the same direction: reporting a suite as greener
 * than it was.
 */

const suite = (body: string, attrs = ''): string =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>\n<testsuite name="s" ${attrs}>\n${body}\n</testsuite>\n</testsuites>`;

describe('JUnit XML', () => {
  it('counts a passing suite', () => {
    const result = parseRunnerOutput(
      suite('<testcase classname="a.B" name="one"/>\n<testcase classname="a.B" name="two"/>'),
    );
    expect(result).toMatchObject({ runner: 'junit-xml', total: 2, passed: 2, failed: 0, ok: true });
  });

  it('treats a testcase with no result element as passed', () => {
    // The format's own definition: "A test passed if there isn't an additional
    // result element underneath it." A non-self-closing case with only
    // `<system-out>` is still a pass.
    const result = parseRunnerOutput(
      suite('<testcase name="one"><system-out>hello</system-out></testcase>'),
    );
    expect(result).toMatchObject({ passed: 1, failed: 0, ok: true });
  });

  it('counts an <error> as a failure, not as a pass', () => {
    // The most dangerous trap in this format. A suite reporting failures="0"
    // errors="3" has three tests that never reached a verdict, and a parser
    // reading only `failures` calls it green.
    const result = parseRunnerOutput(
      suite(
        '<testcase name="one"/>\n<testcase name="two"><error message="boom">trace</error></testcase>',
        'tests="2" failures="0" errors="1"',
      ),
    );
    expect(result).toMatchObject({ total: 2, passed: 1, failed: 1, ok: false });
  });

  it('does not count skipped tests as passing', () => {
    // `tests` includes skipped, so `passed = tests - failures` is wrong: a
    // suite of 10 with 8 skipped and 2 passing is not 10 passing.
    const result = parseRunnerOutput(
      suite(
        '<testcase name="a"/>\n<testcase name="b"><skipped/></testcase>\n<testcase name="c"><skipped message="wip"/></testcase>',
        'tests="3" skipped="2"',
      ),
    );
    expect(result).toMatchObject({ total: 1, passed: 1, failed: 0 });
  });

  it('ignores the suite attributes entirely and counts the elements', () => {
    // The attributes are the producer's claim about its own run — the same
    // category of thing as a `success: true` flag, which this module already
    // refuses. Here they are wildly wrong and the count is still right.
    const result = parseRunnerOutput(
      suite(
        '<testcase name="a"/>\n<testcase name="b"><failure message="no"/></testcase>',
        'tests="99" failures="0" errors="0"',
      ),
    );
    expect(result).toMatchObject({ total: 2, passed: 1, failed: 1, ok: false });
  });

  it('does not double-count when <testsuites> also carries totals', () => {
    // Some producers aggregate on the root and some do not, so a parser that
    // trusted attributes would double-count or under-count depending on whose
    // XML it was handed.
    const xml = `<testsuites tests="2" failures="0">
      <testsuite name="one" tests="1" failures="0"><testcase name="a"/></testsuite>
      <testsuite name="two" tests="1" failures="0"><testcase name="b"/></testsuite>
    </testsuites>`;
    expect(parseRunnerOutput(xml)).toMatchObject({ total: 2, passed: 2 });
  });

  it('does not read a stack trace inside CDATA as more tests', () => {
    // Inside CDATA the angle brackets are not escaped, so a failure message
    // containing XML would inflate the count — in the greener direction, since
    // an unclassified case counts as a pass.
    const result = parseRunnerOutput(
      suite(
        '<testcase name="a"><failure message="bad"><![CDATA[expected <testcase name="ghost"/> got nothing]]></failure></testcase>',
      ),
    );
    expect(result).toMatchObject({ total: 1, passed: 0, failed: 1 });
  });

  it('does not read a commented-out testcase as a test', () => {
    const result = parseRunnerOutput(
      suite('<testcase name="a"/>\n<!-- <testcase name="disabled"/> -->'),
    );
    expect(result).toMatchObject({ total: 1, passed: 1 });
  });

  it('declines a truncated document rather than reporting a partial count', () => {
    // A partial count reported as a total is the exact failure this parser
    // exists to prevent, wearing a success costume.
    const truncated = '<testsuites><testsuite name="s"><testcase name="a"><failure message="x">';
    expect(parseRunnerOutput(truncated)).toBeNull();
  });

  it('reports an empty suite as zero tests, which is not a pass', () => {
    // P1-GATE-01's rule: a zero-test run is not a passing run. Declining here
    // instead would send it to exit-code-only, where an `exit 0` reads as
    // 0.6-confidence success.
    const result = parseRunnerOutput(suite(''));
    expect(result).toMatchObject({ runner: 'junit-xml', total: 0, passed: 0, ok: false });
  });

  it('carries the failing test names and messages into the evidence', () => {
    // None of the other parsers can do this. A gate that says "1 failed" and
    // cannot say which is a gate somebody has to re-run to act on.
    const result = parseRunnerOutput(
      suite(
        '<testcase classname="app.UserTest" name="rejects a blank email"><failure message="expected 400, got 200"/></testcase>',
      ),
    );
    expect(result?.failures).toEqual([
      {
        file: 'app.UserTest',
        title: 'rejects a blank email',
        message: 'expected 400, got 200',
      },
    ]);
  });

  it('is not fooled by prose that merely mentions testsuites', () => {
    expect(parseRunnerOutput('Consider adding a <testsuites> report to your CI.')).toBeNull();
  });

  it('leaves the other parsers alone — a pytest run is still pytest', () => {
    // Ordering regression: junitXml runs last, but a parser that matched too
    // eagerly would steal input from the four that came before it.
    const pytest = '=========== 3 passed, 1 failed in 0.12s ============';
    expect(parseRunnerOutput(pytest)).toMatchObject({ runner: 'pytest' });
  });

  it('handles a single <testsuite> root with no <testsuites> wrapper', () => {
    // pytest's `--junitxml` and several Maven versions emit this shape.
    const xml = '<testsuite name="s" tests="1"><testcase name="a"/></testsuite>';
    expect(parseRunnerOutput(xml)).toMatchObject({ runner: 'junit-xml', total: 1, passed: 1 });
  });
});
