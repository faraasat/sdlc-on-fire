import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { exitCodeFor, renderSyncReport, resolveToken, TokenMissingError } from './tracker.js';
import type { SyncReport } from '@sdlc-on-fire/core';

const tmpDirs: string[] = [];
async function tmpFile(contents: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sdlcof-token-'));
  tmpDirs.push(dir);
  const file = path.join(dir, 'token');
  await fs.writeFile(file, contents, 'utf8');
  return file;
}
afterAll(async () => {
  for (const dir of tmpDirs) await fs.rm(dir, { recursive: true, force: true });
});

describe('resolveToken', () => {
  it('reads the inline variable', async () => {
    await expect(resolveToken({ SDLCOF_GITHUB_TOKEN: 'tok' })).resolves.toBe('tok');
  });

  it('reads a token file and trims the trailing newline an editor leaves', async () => {
    const file = await tmpFile('github_pat_abc\n');
    await expect(resolveToken({ SDLCOF_GITHUB_TOKEN_FILE: file })).resolves.toBe('github_pat_abc');
  });

  it('prefers the file over an inherited variable', async () => {
    // An inherited SDLCOF_GITHUB_TOKEN from an unrelated shell is exactly the
    // accident that syncs a workspace to the wrong account.
    const file = await tmpFile('from-file');
    await expect(
      resolveToken({ SDLCOF_GITHUB_TOKEN_FILE: file, SDLCOF_GITHUB_TOKEN: 'from-env' }),
    ).resolves.toBe('from-file');
  });

  it('rejects a blank variable rather than authenticating with an empty string', async () => {
    await expect(resolveToken({ SDLCOF_GITHUB_TOKEN: '' })).rejects.toThrow(TokenMissingError);
    await expect(resolveToken({ SDLCOF_GITHUB_TOKEN: '   ' })).rejects.toThrow(TokenMissingError);
  });

  it('rejects an empty token file', async () => {
    const file = await tmpFile('\n\n');
    await expect(resolveToken({ SDLCOF_GITHUB_TOKEN_FILE: file })).rejects.toThrow(
      TokenMissingError,
    );
  });

  it('rejects nothing at all, and says how to supply it', async () => {
    await expect(resolveToken({})).rejects.toThrow(/SDLCOF_GITHUB_TOKEN/);
  });

  it('explains why there is no --token flag, so nobody adds one back', async () => {
    await expect(resolveToken({})).rejects.toThrow(/ps|shell history/);
  });
});

const report = (over: Partial<SyncReport> = {}): SyncReport => ({
  ok: true,
  outcomes: [],
  conflicts: [],
  failures: [],
  applied: 0,
  dryRun: false,
  ...over,
});

describe('exitCodeFor', () => {
  it('is zero on a clean run', () => {
    expect(exitCodeFor(report())).toBe(0);
  });

  it('is non-zero when the run was not ok, so a scheduled sync fails loudly', () => {
    expect(exitCodeFor(report({ ok: false }))).toBe(1);
  });
});

describe('renderSyncReport', () => {
  it('says plainly that a dry run wrote nothing', () => {
    expect(renderSyncReport(report({ dryRun: true }))).toContain('nothing was written');
  });

  it('counts the actions it took', () => {
    const out = renderSyncReport(
      report({
        applied: 2,
        outcomes: [
          { key: 'a', decision: { action: 'push', because: 'x' } },
          { key: 'b', decision: { action: 'push', because: 'x' } },
          { key: 'c', decision: { action: 'none', because: 'x' } },
        ],
      }),
    );
    expect(out).toContain('Applied 2 change(s)');
    expect(out).toContain('push: 2');
    expect(out).toContain('none: 1');
  });

  it('names every failure rather than only counting them', () => {
    const out = renderSyncReport(
      report({
        ok: false,
        outcomes: [{ key: 'a', decision: { action: 'push', because: 'x' }, failure: '422 boom' }],
        failures: [{ key: 'a', decision: { action: 'push', because: 'x' }, failure: '422 boom' }],
      }),
    );
    expect(out).toContain('422 boom');
    expect(out).toContain('a');
  });

  it('tells the operator nothing was overwritten when there are conflicts', () => {
    const conflict = {
      key: 'k',
      decision: { action: 'conflict' as const, because: 'both sides changed' },
    };
    const out = renderSyncReport(
      report({ ok: false, outcomes: [conflict], conflicts: [conflict] }),
    );
    expect(out).toContain('Nothing was overwritten');
  });
});
