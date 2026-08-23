import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';
import { renderJsonFailure } from './index.js';

const run = promisify(execFile);
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');

/**
 * The `--json` contract, on both paths (P6-SURFACE-01).
 *
 * `--json` used to emit a parseable document on success and **zero bytes on
 * stdout** on failure, with prose on stderr. An agent that asked for JSON got a
 * parse error and no machine-readable reason — and this product's positioning is
 * a pipeline driven by coding agents, so the failure path is where structure
 * matters most and was exactly where it was missing.
 *
 * The OpenSpec code study told us to enforce this *structurally* rather than by
 * per-command discipline. Ninety commands accept `--json`. This is the check
 * that makes it a mechanism instead of a promise.
 */
let root: string;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'sdlcof-json-'));
  await run('node', [CLI, '-C', root, 'init']).catch(() => undefined);
}, 120_000);

async function invoke(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await run('node', [CLI, '-C', root, ...args]);
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code ?? 1 };
  }
}

/** Failures reachable without setting up state, across several command shapes. */
const FAILING = [
  ['nonsense', '--json'], //            unknown command, raised by the root
  ['new', '--json'], //                 missing argument, raised by a subcommand
  ['instructions', 'NOPE-999', '--json'], // a real runtime error
  ['advance', '--json'], //             missing argument on another subcommand
  ['verify', 'NOPE-999', '--json'], //  runtime error in a different module
];

describe('--json emits exactly one document, whatever happens', () => {
  it.each(FAILING)(
    '%s %s %s → parseable stdout, empty stderr, non-zero exit',
    async (...args) => {
      const result = await invoke(args);
      expect(result.code).not.toBe(0);
      // The document, not prose.
      const parsed = JSON.parse(result.stdout) as { error?: { message?: string } };
      expect(typeof parsed.error?.message).toBe('string');
      // And *only* the document: a second, unstructured half leaves an agent
      // parsing a stream it cannot trust.
      expect(result.stderr).toBe('');
    },
    120_000,
  );

  it('still emits one parseable document on success', async () => {
    const result = await invoke(['status', '--json']);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(parsed).toHaveProperty('initialised');
    // Success carries no `error` key — that is how a caller tells them apart.
    expect(parsed['error']).toBeUndefined();
  }, 120_000);

  it('never writes two documents, even when two layers both report', async () => {
    // commander's exitOverride rethrows so the process still stops; the
    // rethrown error then reaches the top-level catch. Both call the reporter.
    // Without a latch this produced two JSON documents on stdout — the exact
    // rule being enforced, broken by the code enforcing it.
    const result = await invoke(['nonsense', '--json']);
    expect(() => JSON.parse(result.stdout) as unknown).not.toThrow();
    expect(
      result.stdout
        .trim()
        .split('\n')
        .filter((l) => l === '}').length,
    ).toBe(1);
  }, 120_000);

  it('does not turn --help into an error document', async () => {
    // `--help` reaches the same exitOverride having already written its output
    // and succeeded. Reporting it as a failure would tell an agent the command
    // broke when it did exactly what was asked. Both the root and a subcommand,
    // because the override is installed on every command.
    for (const args of [
      ['--help', '--json'],
      ['status', '--help', '--json'],
    ]) {
      const result = await invoke(args);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('Usage:');
      expect(result.stdout).not.toContain('"error"');
    }
  }, 120_000);

  it('leaves human output alone when --json was not asked for', async () => {
    const result = await invoke(['instructions', 'NOPE-999']);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('NOPE-999');
  }, 120_000);
});

describe('renderJsonFailure', () => {
  it('carries a code when the error has one, so callers need not match on wording', () => {
    const error = Object.assign(new Error('nope'), { code: 'commander.unknownCommand' });
    const parsed = JSON.parse(renderJsonFailure(error)) as { error: { code?: string } };
    expect(parsed.error.code).toBe('commander.unknownCommand');
  });

  it('omits code rather than inventing one', () => {
    const parsed = JSON.parse(renderJsonFailure(new Error('plain'))) as {
      error: Record<string, unknown>;
    };
    expect(parsed.error).not.toHaveProperty('code');
    expect(parsed.error['message']).toBe('plain');
  });

  it('handles a throw that is not an Error at all', () => {
    const parsed = JSON.parse(renderJsonFailure('just a string')) as { error: { message: string } };
    expect(parsed.error.message).toBe('just a string');
  });
});
