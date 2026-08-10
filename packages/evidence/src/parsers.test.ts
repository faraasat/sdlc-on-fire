import { describe, expect, it } from 'vitest';
import {
  ParseError,
  parseBuildResult,
  parseTscOutput,
  parseVitestJson,
  payloadHash,
} from './parsers.js';

const passing = JSON.stringify({
  numTotalTests: 3,
  numPassedTests: 3,
  numFailedTests: 0,
  success: true,
  testResults: [{ name: '/a.test.ts', assertionResults: [{ title: 'x', status: 'passed' }] }],
});

describe('vitest/jest parser', () => {
  it('reads a passing run', () => {
    expect(parseVitestJson(passing)).toMatchObject({ total: 3, passed: 3, failed: 0, ok: true });
  });

  it('extracts failure detail', () => {
    const raw = JSON.stringify({
      numTotalTests: 2,
      numPassedTests: 1,
      numFailedTests: 1,
      testResults: [
        {
          name: '/a.test.ts',
          assertionResults: [
            { fullName: 'suite > passes', status: 'passed' },
            {
              fullName: 'suite > fails',
              status: 'failed',
              failureMessages: ['expected 1 to be 2'],
            },
          ],
        },
      ],
    });
    const evidence = parseVitestJson(raw);
    expect(evidence.ok).toBe(false);
    expect(evidence.failures[0]).toMatchObject({ file: '/a.test.ts', title: 'suite > fails' });
    expect(evidence.failures[0]?.message).toContain('expected 1 to be 2');
  });

  it('does not treat a zero-test run as a pass', () => {
    // "Nothing ran" and "everything passed" are different facts.
    const raw = JSON.stringify({
      numTotalTests: 0,
      numPassedTests: 0,
      numFailedTests: 0,
      success: true,
    });
    expect(parseVitestJson(raw).ok).toBe(false);
  });

  it('derives ok from failures, not the reporter success flag', () => {
    // A runner that crashed mid-suite can report success: true.
    const raw = JSON.stringify({
      numTotalTests: 2,
      numPassedTests: 1,
      numFailedTests: 1,
      success: true,
    });
    expect(parseVitestJson(raw).ok).toBe(false);
  });

  it('throws rather than manufacturing an empty result', () => {
    expect(() => parseVitestJson('not json')).toThrow(ParseError);
    expect(() => parseVitestJson('{"nope":1}')).toThrow(ParseError);
  });
});

describe('tsc parser', () => {
  it('extracts diagnostics', () => {
    const raw = "src/a.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.";
    const evidence = parseTscOutput(raw, 2);
    expect(evidence.ok).toBe(false);
    expect(evidence.errors[0]).toMatchObject({ file: 'src/a.ts', line: 12 });
  });

  it('treats exit code as authoritative', () => {
    expect(parseTscOutput('', 0).ok).toBe(true);
    // A crash with no parseable diagnostic is still a failure, not a pass.
    const crashed = parseTscOutput('Segmentation fault', 139);
    expect(crashed.ok).toBe(false);
    expect(crashed.errorCount).toBe(1);
  });
});

describe('build parser', () => {
  it('maps exit code to ok', () => {
    expect(parseBuildResult({ cmd: 'pnpm build', exitCode: 0, durationMs: 10 }).ok).toBe(true);
    expect(parseBuildResult({ cmd: 'pnpm build', exitCode: 1, durationMs: 10 }).ok).toBe(false);
  });

  it('rejects an implausible duration', () => {
    expect(() => parseBuildResult({ cmd: 'x', exitCode: 0, durationMs: -1 })).toThrow(ParseError);
  });
});

describe('payload hash', () => {
  it('is stable across key order', () => {
    expect(payloadHash({ a: 1, b: 2 })).toBe(payloadHash({ b: 2, a: 1 }));
  });

  it('differs on different content', () => {
    expect(payloadHash({ a: 1 })).not.toBe(payloadHash({ a: 2 }));
  });
});
