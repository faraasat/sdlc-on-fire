/**
 * Workspace-relative paths are posix strings, not filesystem paths.
 *
 * ADR-0072 committed to native Windows and its audit concluded path handling
 * was already sound, on the evidence that several modules ended their path
 * expressions with `.replace(/\\/g, '/')`. The first Windows CI run disagreed:
 * eleven test files failed on separators alone, every one of them in a module
 * written after that audit. The convention was real and nothing enforced it, so
 * each new module re-derived it or didn't.
 *
 * The distinction the convention was reaching for is this. A path used to
 * *reach* a file is a filesystem path, and `path.join` is correct for it. A path
 * used as an **identity** — a map key, a card's `path` field, a glob subject, a
 * string in a finding, anything compared against a literal written in a test or
 * a config file — is a posix string, and `path.join` is the wrong tool: it
 * yields `docs\a.md` on Windows, which matches no glob anyone wrote and equals
 * no literal anyone typed. The two look identical on the platform the author
 * was using.
 *
 * So identities are built here, not with `path`. `relativePosix` for one derived
 * from a root, `toPosixPath` for one arriving from elsewhere (git reports
 * `C:/…`, a config file may say either). Both are pure string work and behave
 * the same on every platform, which is what lets a Linux test run prove a
 * Windows result rather than merely not contradicting it.
 */

import path from 'node:path';

/**
 * Rewrites a path's separators to `/`.
 *
 * Drive letters and UNC prefixes survive unchanged — this converts a path's
 * *shape*, it does not make an absolute Windows path relative or portable.
 * A leading `./` is dropped because `./a.md` and `a.md` are the same identity
 * and only one of them matches a stored key.
 */
export function toPosixPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * The workspace-relative identity of `to`, as seen from `from`.
 *
 * This is `path.relative` with the result converted to an identity. Use it
 * wherever the result is stored, compared, matched against a glob, or shown to
 * a person; use `path.relative` directly only when the result is immediately
 * handed back to the filesystem.
 */
export function relativePosix(from: string, to: string): string {
  return toPosixPath(path.relative(from, to));
}

/**
 * Appends a segment to a workspace-relative path.
 *
 * `path.join` would be correct except for the separator, and the separator is
 * the whole problem — this is the accumulator used while walking a tree, where
 * every intermediate value is an identity rather than something opened.
 */
export function joinPosix(parent: string, segment: string): string {
  return parent === '' ? segment : `${parent}/${segment}`;
}
