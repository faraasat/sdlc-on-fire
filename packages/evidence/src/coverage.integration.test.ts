import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { parseCoverage, parseIstanbulSummary, parseLcov } from './coverage.js';

/**
 * P2-QA-02 — parsed against coverage this repository actually produces.
 *
 * The formats are the point of failure. A hand-written lcov fixture proves the
 * parser agrees with my memory of lcov, which is the assumption worth not
 * making — so this runs Vitest with the v8 provider in a real temporary
 * project and parses whatever comes out.
 */

const run = promisify(execFile);
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

/** A tiny real project, half-covered on purpose. */
async function coveredProject(): Promise<{ lcov: string; summary: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cov-'));
  dirs.push(root);

  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'src', 'math.ts'),
    [
      'export function add(a: number, b: number): number {',
      '  return a + b;',
      '}',
      '',
      'export function neverCalled(a: number): number {',
      '  const doubled = a * 2;',
      '  const tripled = doubled + a;',
      '  return tripled;',
      '}',
      '',
    ].join('\n'),
    'utf8',
  );
  await fs.writeFile(
    path.join(root, 'src', 'math.test.ts'),
    [
      "import { describe, expect, it } from 'vitest';",
      "import { add } from './math.js';",
      '',
      "describe('add', () => {",
      "  it('adds', () => {",
      '    expect(add(1, 2)).toBe(3);',
      '  });',
      '});',
      '',
    ].join('\n'),
    'utf8',
  );
  await fs.writeFile(
    path.join(root, 'vitest.config.ts'),
    [
      "import { defineConfig } from 'vitest/config';",
      'export default defineConfig({',
      '  test: {',
      "    include: ['src/**/*.test.ts'],",
      '    coverage: {',
      "      provider: 'v8',",
      "      include: ['src/**/*.ts'],",
      "      exclude: ['src/**/*.test.ts'],",
      "      reporter: ['lcov', 'json-summary'],",
      '    },',
      '  },',
      '});',
      '',
    ].join('\n'),
    'utf8',
  );

  const vitestBin = path.join(process.cwd(), 'node_modules', '.bin', 'vitest');
  await run(vitestBin, ['run', '--coverage'], { cwd: root, timeout: 120_000 });

  return {
    lcov: await fs.readFile(path.join(root, 'coverage', 'lcov.info'), 'utf8'),
    summary: await fs.readFile(path.join(root, 'coverage', 'coverage-summary.json'), 'utf8'),
  };
}

describe('parsing real Vitest coverage output', () => {
  it('reads lcov as Vitest writes it', async () => {
    const { lcov } = await coveredProject();
    const report = parseLcov(lcov);

    expect(report.format).toBe('lcov');
    expect(report.files).toHaveLength(1);
    expect(report.files[0]?.file).toContain('math.ts');
    // Half the module is exercised, so coverage must land strictly between the
    // two ends. Asserting a specific number would pin the test to v8's counting
    // rather than to the parser.
    expect(report.pct).toBeGreaterThan(0);
    expect(report.pct).toBeLessThan(100);
  }, 180_000);

  it('reads the Istanbul summary and agrees with lcov', async () => {
    // Two formats describing one run. If the parsers disagree, at least one is
    // wrong, and no hand-written fixture would ever reveal it.
    const { lcov, summary } = await coveredProject();
    const fromLcov = parseLcov(lcov);
    const fromSummary = parseIstanbulSummary(summary);

    expect(fromSummary.format).toBe('istanbul-summary');
    expect(fromSummary.files).toHaveLength(1);
    expect(Math.abs(fromSummary.pct - fromLcov.pct)).toBeLessThan(0.01);
  }, 180_000);

  it('does not count the summary’s `total` roll-up as a file', async () => {
    // It would double every number and put a file called "total" in the list.
    const { summary } = await coveredProject();
    expect(parseIstanbulSummary(summary).files.map((f) => f.file)).not.toContain('total');
  }, 180_000);

  it('picks the parser from the content, not the filename', async () => {
    const { lcov, summary } = await coveredProject();
    expect(parseCoverage(lcov).format).toBe('lcov');
    expect(parseCoverage(summary).format).toBe('istanbul-summary');
  }, 180_000);
});
