import type { SandboxConfig } from '@sdlc-on-fire/core';

/**
 * Platform-specific sandbox construction (P1-SEC-02, ADR-0036).
 *
 * The vocabulary and the decision live in `core/sandbox.ts`, because the config
 * schema has to be readable by anything that reads config. What is here is the
 * part that knows what a Seatbelt profile or a bubblewrap invocation looks like.
 */

/**
 * A Seatbelt profile confining writes.
 *
 * `(allow default)` then denying is deliberate and worth defending: a
 * deny-by-default profile has to enumerate every path a toolchain touches —
 * caches, temporary directories, the module resolver's walk — and a profile that
 * breaks `pnpm test` gets switched off within a day, which protects nothing at
 * all. This confines the destructive direction (writes outside the workspace)
 * while leaving reads open, and says so rather than implying more.
 *
 * Paths are quoted and backslash-escaped: a workspace path containing a quote
 * would otherwise terminate the s-expression early and produce a profile that
 * silently permits more than intended.
 */
export function seatbeltProfile(
  config: SandboxConfig,
  workspaceRoot: string,
  /**
   * This process's own temp directory — **not** all of `/tmp`.
   *
   * The first version of this profile blanket-allowed `/private/tmp`, and the
   * real-enforcement test caught it immediately: `/tmp` is world-writable and
   * shared, so allowing it wholesale meant a command could write anywhere most
   * people keep scratch files. A sandbox with a hole that size is decorative.
   * A toolchain still needs *a* writable temp, so it gets exactly one.
   */
  tmpDir: string,
): string {
  const quote = (value: string): string => `"${value.replace(/(["\\])/g, '\\$1')}"`;
  const allowed = [workspaceRoot, tmpDir, ...config.filesystem.allowWrite];

  return [
    '(version 1)',
    '(allow default)',
    // Deny writes everywhere, then re-allow the workspace and anything declared.
    // Order matters: in Seatbelt the last matching rule wins.
    '(deny file-write*)',
    ...allowed.map((path) => `(allow file-write* (subpath ${quote(path)}))`),
    // Explicit denials come last so they cannot be undone by an allow above.
    ...config.filesystem.denyWrite.map((path) => `(deny file-write* (subpath ${quote(path)}))`),
    // The standard sinks, which are not filesystem writes in any meaningful
    // sense and whose absence breaks every command that prints anything.
    '(allow file-write-data (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr"))',
    '',
  ].join('\n');
}

/** Arguments wrapping a command in bubblewrap, writable only where declared. */
export function bubblewrapArgs(config: SandboxConfig, workspaceRoot: string): readonly string[] {
  // `--tmpfs /tmp` gives a private, empty temp that vanishes with the process,
  // so bubblewrap needs no equivalent of Seatbelt's explicit temp allowance.
  const writable = [workspaceRoot, ...config.filesystem.allowWrite];
  return [
    // Read-only bind of the whole filesystem, then writable binds on top. The
    // same shape as the Seatbelt profile, for the same reason.
    '--ro-bind',
    '/',
    '/',
    '--dev',
    '/dev',
    '--proc',
    '/proc',
    '--tmpfs',
    '/tmp',
    ...writable.flatMap((path) => ['--bind', path, path]),
    '--die-with-parent',
  ];
}
