import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_STATE_DIR, resolveWorkspacePaths } from './paths.js';

describe('workspace paths', () => {
  it('places machine state under the hidden state directory', () => {
    const paths = resolveWorkspacePaths('/tmp/project');
    expect(paths.stateDir).toBe(path.join('/tmp/project', DEFAULT_STATE_DIR));
    expect(paths.dataDir).toBe(path.join('/tmp/project', DEFAULT_STATE_DIR, 'db'));
    expect(paths.lockDir).toBe(path.join('/tmp/project', DEFAULT_STATE_DIR, 'locks'));
    expect(paths.logDir).toBe(path.join('/tmp/project', DEFAULT_STATE_DIR, 'logs'));
  });

  it('absolutises a relative root', () => {
    expect(path.isAbsolute(resolveWorkspacePaths('.').root)).toBe(true);
  });

  it('honours a custom state directory name', () => {
    const paths = resolveWorkspacePaths('/tmp/project', '.custom');
    expect(paths.dataDir).toBe(path.join('/tmp/project', '.custom', 'db'));
  });

  it('creates nothing — resolution is pure', async () => {
    const { stat } = await import('node:fs/promises');
    const paths = resolveWorkspacePaths('/tmp/definitely-not-created-by-this-test');
    await expect(stat(paths.stateDir)).rejects.toThrow();
  });
});
