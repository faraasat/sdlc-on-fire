/**
 * Setup failures that name the fix, not the errno (P6-SURFACE-10).
 *
 * Found by the published-package pilot: a read-only directory produced
 * `EACCES: permission denied, mkdir '<path>'`, a file colliding with the
 * `kanban/` directory produced `ENOTDIR: not a directory, mkdir '<path>'`, and
 * an invalid `config.yaml` produced a bare YAML parser complaint that never
 * named the file, never said it was the workspace config, and never said what
 * to do.
 *
 * None of those is a crash. All three fall short of the standard this product
 * already sets elsewhere — the `tiers` message, the `verify` confidence warning,
 * `DatabaseLockedError` — and the gap matters most at setup, which is the one
 * moment the user has no context at all and every reason to give up.
 *
 * The mapping is **data**, keyed on `errno`. An `if` chain grows a branch per
 * incident and the tenth one lands in whichever function the reporter happened
 * to be looking at.
 */

export class SetupError extends Error {
  override readonly name = 'SetupError';
  constructor(
    message: string,
    readonly code: string | undefined,
    override readonly cause: unknown,
  ) {
    super(message);
  }
}

interface Remedy {
  /** What went wrong, in the user's terms rather than the syscall's. */
  readonly what: (where: string) => string;
  /** What to actually do. One concrete action, not a category. */
  readonly fix: string;
}

const REMEDIES: Readonly<Record<string, Remedy>> = {
  EACCES: {
    what: (where) => `cannot write to ${where}`,
    fix: 'check the directory is writable by you — `ls -ld` on it, and pick a different location if it belongs to another user',
  },
  EPERM: {
    what: (where) => `not permitted to write to ${where}`,
    fix: 'the path is likely owned by another user or locked by the OS; run from a directory you own',
  },
  ENOTDIR: {
    what: (where) => `${where} is blocked by a file with the same name`,
    fix: 'a plain file is sitting where a directory needs to be — rename or remove it, then run this again',
  },
  EEXIST: {
    what: (where) => `${where} already exists and is not what was expected`,
    fix: 'remove or rename it, then run this again',
  },
  ENOSPC: {
    what: (where) => `no space left on the device holding ${where}`,
    fix: 'free some space — `df -h` on that path will say how much is left',
  },
  EROFS: {
    what: (where) => `${where} is on a read-only filesystem`,
    fix: 'choose a writable location; this one cannot be written to at all',
  },
  EMFILE: {
    what: () => 'too many files are open',
    fix: 'raise the open-file limit (`ulimit -n`) or close whatever else is holding them',
  },
};

/**
 * Turns a filesystem failure into something actionable, or rethrows.
 *
 * Rethrows deliberately when the code is unrecognised: inventing a remedy for
 * an errno nobody has seen is worse than showing the original, because the
 * original is at least true.
 */
export function explainFilesystemError(cause: unknown, where: string, doing: string): never {
  const code = (cause as NodeJS.ErrnoException | undefined)?.code;
  const remedy = code === undefined ? undefined : REMEDIES[code];
  if (remedy === undefined) throw cause;

  throw new SetupError(
    `${doing} failed — ${remedy.what(where)}.\n  ${remedy.fix}\n  (${code})`,
    code,
    cause,
  );
}

/**
 * Explains a YAML parse failure against the file it came from.
 *
 * The parser's message is kept, at the end. It is genuinely useful once you know
 * which file it is about — "line 2, column 1" means nothing on its own, and
 * dropping it would trade one unhelpful message for another.
 */
export function explainYamlError(cause: unknown, filePath: string, what: string): never {
  const detail = cause instanceof Error ? cause.message : String(cause);
  throw new SetupError(
    `${filePath} is not valid YAML, so ${what} could not be read.\n` +
      '  Fix the syntax, or delete the file and run `sdlc init` to write a fresh one.\n' +
      `  The parser said: ${detail}`,
    'EYAML',
    cause,
  );
}
