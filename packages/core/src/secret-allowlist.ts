/**
 * The secret-scan allowlist (P2-SEC-02).
 *
 * A secret scanner that cannot express "this one is a documented example"
 * blocks every repository that takes security seriously enough to have tests
 * for it — including this one. Dogfooding `sdlc scan` on our own product repo
 * refused 20 findings, every one of them a fixture: AWS's own published
 * example key, Stripe's documented test key, a `postgres://user:password@`
 * string in an error message.
 *
 * **This reads the `.gitleaks.toml` that already exists** (added by P0-META-04)
 * rather than introducing a second, parallel allowlist. Two config files that
 * both decide what counts as a secret would drift, and the day they disagree is
 * the day someone believes the wrong one.
 *
 * **Why a hand-written reader.** This understands one shape — `[allowlist]`
 * with `paths` and `regexes` string arrays — and nothing else. Pulling in a
 * TOML parser for two arrays is a dependency, a supply-chain surface, and an
 * ADR-0045 research pass, in exchange for syntax this file does not need.
 *
 * **The direction it fails in is the point.** An unreadable, missing, or
 * unparseable config yields an *empty* allowlist, never a permissive one. The
 * cost of being wrong is then a false positive somebody sees and fixes, rather
 * than a real credential silently permitted by a config nobody noticed was
 * broken.
 */

export interface SecretAllowlist {
  /** File paths exempt from scanning entirely. */
  readonly paths: readonly RegExp[];
  /** Values that are known examples wherever they appear. */
  readonly regexes: readonly RegExp[];
}

export const EMPTY_ALLOWLIST: SecretAllowlist = { paths: [], regexes: [] };

/**
 * Markers that exempt a single line.
 *
 * `gitleaks:allow` is gitleaks' own convention, honoured so a repo already
 * annotated for gitleaks does not have to be annotated twice.
 */
const INLINE_ALLOW = /(?:gitleaks|sdlc):allow(?:-secret)?/;

export function hasInlineAllow(line: string): boolean {
  return INLINE_ALLOW.test(line);
}

/** Strips `#` comments that are not inside a string. */
function withoutComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === "'" && !inDouble) inSingle = !inSingle;
    else if (char === '"' && !inSingle) inDouble = !inDouble;
    else if (char === '#' && !inSingle && !inDouble) return line.slice(0, i);
  }
  return line;
}

/** Every quoted string on a line, in any of TOML's four quote forms. */
function quotedStrings(text: string): string[] {
  const found: string[] = [];
  // Multi-line (triple-quoted) forms first: `'''…'''` is what gitleaks configs
  // use for regexes, precisely so backslashes need no escaping.
  for (const match of text.matchAll(/'''([\s\S]*?)'''|"""([\s\S]*?)"""/g)) {
    found.push(match[1] ?? match[2] ?? '');
  }
  const withoutTriples = text.replace(/'''[\s\S]*?'''|"""[\s\S]*?"""/g, '');
  for (const match of withoutTriples.matchAll(/'([^']*)'|"((?:[^"\\]|\\.)*)"/g)) {
    found.push(match[1] ?? match[2] ?? '');
  }
  return found;
}

/**
 * Reads the `[allowlist]` section of a `.gitleaks.toml`.
 *
 * An entry that is not a valid regular expression is dropped rather than
 * thrown, and dropping is the safe direction: one rule fewer means one more
 * finding reported, which a person sees.
 */
export function parseSecretAllowlist(toml: string): SecretAllowlist {
  const paths: RegExp[] = [];
  const regexes: RegExp[] = [];

  let section = '';
  let key: 'paths' | 'regexes' | null = null;
  let buffer = '';

  const flush = (): void => {
    if (key === null) return;
    for (const value of quotedStrings(buffer)) {
      if (value === '') continue;
      try {
        (key === 'paths' ? paths : regexes).push(new RegExp(value));
      } catch {
        // An unparseable pattern exempts nothing. Silently widening the
        // allowlist to compensate would be the one unsafe response.
      }
    }
    key = null;
    buffer = '';
  };

  for (const rawLine of toml.split('\n')) {
    const line = withoutComment(rawLine);

    const header = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (header !== null) {
      flush();
      section = header[1]?.trim() ?? '';
      continue;
    }

    if (key !== null) {
      buffer += `\n${line}`;
      if (line.includes(']')) flush();
      continue;
    }

    if (section !== 'allowlist') continue;

    const assignment = /^\s*(paths|regexes)\s*=\s*(.*)$/.exec(line);
    if (assignment === null) continue;

    key = assignment[1] as 'paths' | 'regexes';
    buffer = assignment[2] ?? '';
    if (buffer.includes(']')) flush();
  }
  flush();

  return { paths, regexes };
}

/** Whether a repo-relative path is exempt from scanning. */
export function isAllowlistedPath(allowlist: SecretAllowlist, relativePath: string): boolean {
  return allowlist.paths.some((pattern) => pattern.test(relativePath));
}

/**
 * Whether a finding is a documented example rather than a credential.
 *
 * Tested against the surrounding line as well as the matched value, because
 * the two do not always coincide. This repo's own config allowlists the full
 * `postgres://user:password@host:port/database` placeholder, while the
 * detector that fires on it captures only `postgres://user:password@` — the
 * part that identifies embedded credentials in *any* DSN. Comparing the
 * allowlist pattern against the truncated match would leave an entry that
 * looks correct, was reviewed, and exempts nothing.
 *
 * The granularity this gives is line-level, the same as an inline
 * `gitleaks:allow` marker — so the cost is bounded and already familiar: a
 * real credential written on the same line as a documented example goes
 * unreported. That is a line someone would have to write deliberately.
 */
export function isAllowlistedValue(allowlist: SecretAllowlist, value: string, line = ''): boolean {
  return allowlist.regexes.some((pattern) => pattern.test(value) || pattern.test(line));
}
