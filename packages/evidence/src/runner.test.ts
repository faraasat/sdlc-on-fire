import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { extractJson, runBuild, runCommand, runTests, runTypecheck } from './runner.js';

/**
 * Runs real commands. The claim is "the daemon executes and captures output" —
 * a mocked child process would prove only that the mock returned what it was
 * told to.
 */

const context = { cwd: os.tmpdir(), gitSha: 'a'.repeat(40) };

describe('extractJson', () => {
  it('pulls the document out of noisy output', () => {
    expect(extractJson('progress...\n{"a":1}\ndone')).toBe('{"a":1}');
  });

  it('returns the input unchanged when there is no object', () => {
    // So the parser reports "not valid JSON" rather than parsing an empty string.
    expect(extractJson('no json here')).toBe('no json here');
  });
});

describe('runCommand', () => {
  it('captures stdout and a zero exit', async () => {
    const result = await runCommand('node', ['-e', 'console.log("hi")'], context);
    expect(result.stdout.trim()).toBe('hi');
    expect(result.exitCode).toBe(0);
  }, 30_000);

  it('treats a non-zero exit as data, not an exception', async () => {
    // A failing run is exactly the evidence the gate needs; throwing would discard it.
    const result = await runCommand('node', ['-e', 'process.exit(3)'], context);
    expect(result.exitCode).toBe(3);
  }, 30_000);
});

describe('daemon-produced envelopes', () => {
  it('produces test evidence marked producer: daemon', async () => {
    const report = JSON.stringify({ numTotalTests: 1, numPassedTests: 1, numFailedTests: 0 });
    const envelope = await runTests(
      'node',
      ['-e', `console.log(${JSON.stringify(report)})`],
      context,
    );

    expect(envelope.producer).toBe('daemon');
    expect(envelope.kind).toBe('test');
    expect(envelope.payload).toMatchObject({ ok: true, total: 1 });
    expect(envelope.command?.exit_code).toBe(0);
    expect(envelope.content_hash).toMatch(/^[0-9a-f]{64}$/);
  }, 30_000);

  it('records a failing typecheck as failing', async () => {
    const envelope = await runTypecheck('node', ['-e', 'process.exit(2)'], context);
    expect(envelope.payload).toMatchObject({ ok: false });
  }, 30_000);

  it('records build success and duration', async () => {
    const envelope = await runBuild('node', ['-e', '0'], context);
    expect(envelope.payload).toMatchObject({ ok: true });
    expect((envelope.payload as { durationMs: number }).durationMs).toBeGreaterThanOrEqual(0);
  }, 30_000);

  it('sets dirty_tree_hash only when there is uncommitted state', async () => {
    const clean = await runBuild('node', ['-e', '0'], context);
    expect(clean.dirty_tree_hash).toBeUndefined();

    const dirty = await runBuild('node', ['-e', '0'], {
      ...context,
      dirtyTreeHash: 'b'.repeat(64),
    });
    expect(dirty.dirty_tree_hash).toBe('b'.repeat(64));
  }, 30_000);
});
