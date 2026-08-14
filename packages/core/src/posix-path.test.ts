import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { joinPosix, relativePosix, toPosixPath } from './posix-path.js';

/**
 * These run identically on every platform, which is the point.
 *
 * A test that asserts `path.relative(...)` equals `'docs/a.md'` passes on Linux
 * for the same reason the bug it was meant to catch is invisible there. The
 * inputs below are literal backslash strings, so the Windows case is exercised
 * on the CI runner that found the problem *and* on the laptop that didn't.
 */

describe('toPosixPath', () => {
  it('converts backslashes', () => {
    expect(toPosixPath('docs\\plan\\a.md')).toBe('docs/plan/a.md');
  });

  it('drops a leading ./ so one identity has one spelling', () => {
    expect(toPosixPath('./docs/a.md')).toBe('docs/a.md');
    expect(toPosixPath('.\\docs\\a.md')).toBe('docs/a.md');
  });

  it('leaves an already-posix path alone', () => {
    expect(toPosixPath('docs/a.md')).toBe('docs/a.md');
  });

  it('keeps a Windows absolute path absolute', () => {
    // Converting the shape is not the same as making it portable, and quietly
    // stripping `C:` would produce a path that resolves somewhere real and
    // wrong.
    expect(toPosixPath('C:\\repo\\docs\\a.md')).toBe('C:/repo/docs/a.md');
  });

  it('does not collapse a UNC prefix', () => {
    expect(toPosixPath('\\\\server\\share\\a.md')).toBe('//server/share/a.md');
  });
});

describe('relativePosix', () => {
  it('agrees with path.relative except for the separator', () => {
    const root = path.resolve('/tmp/project');
    const file = path.resolve('/tmp/project/docs/a.md');
    expect(relativePosix(root, file)).toBe('docs/a.md');
    // The bug, stated: this is what the old code returned on Windows.
    expect(toPosixPath(path.relative(root, file))).toBe(relativePosix(root, file));
  });

  it('still reports a path outside the root', () => {
    const inside = relativePosix(path.resolve('/tmp/project'), path.resolve('/tmp/other/a.md'));
    // `..` is a real answer, not a failure — callers decide what to do with it.
    expect(inside.startsWith('../')).toBe(true);
  });
});

describe('joinPosix', () => {
  it('starts from nothing without a leading slash', () => {
    expect(joinPosix('', 'docs')).toBe('docs');
  });

  it('accumulates with a forward slash on every platform', () => {
    expect(joinPosix(joinPosix('', 'docs'), 'a.md')).toBe('docs/a.md');
  });
});
