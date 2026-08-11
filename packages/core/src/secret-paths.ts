/**
 * The secret-path denylist (P2-SEC-02, `.research/14 §(c)`).
 *
 * Enforced at the daemon's file-tool mediation layer: an agent asking to read
 * `.env` is refused by the mediator, not trusted to have been told not to ask.
 *
 * This is the cheapest control in the security layer and the one with the best
 * ratio of protection to complexity, because it does not depend on recognising
 * a secret — only on recognising where secrets live. A rotated token in a new
 * format is unrecognisable to a scanner and still sits in `.env`.
 *
 * **Denying the read is strictly better than redacting it afterwards.** Content
 * that never enters context cannot be summarised into a commit message, echoed
 * into a log, or carried into the next agent's prompt.
 */

import path from 'node:path';

/** Filenames that are credential stores regardless of what is in them. */
const DENIED_NAMES = new Set([
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  '.npmrc',
  '.pypirc',
  '.netrc',
  '_netrc',
  '.htpasswd',
  'credentials',
  'credentials.json',
  'service-account.json',
  '.pgpass',
  '.dockercfg',
  'secring.gpg',
]);

const DENIED_EXTENSIONS = new Set([
  '.pem',
  '.key',
  '.p12',
  '.pfx',
  '.jks',
  '.keystore',
  '.asc',
  '.ppk',
]);

/** Directories that are wholly credential material. */
const DENIED_DIRECTORIES = ['.ssh', '.gnupg', '.aws', '.config/gcloud', '.kube'];

/**
 * `.env` and its variants.
 *
 * `.env.example` is deliberately *not* denied: it is committed on purpose,
 * contains placeholders by definition, and is often the one file an agent
 * genuinely needs in order to write correct configuration. Denying it teaches
 * people the denylist is noise.
 */
const ENV_FILE = /^\.env(?:\.[A-Za-z0-9_-]+)*$/;
const ENV_ALLOWED = /\.(?:example|sample|template|dist)$/i;

export interface PathVerdict {
  readonly denied: boolean;
  /** Why, in words a person can act on. Empty when allowed. */
  readonly reason: string;
}

/**
 * Whether a path is credential material an agent must not read.
 *
 * Matching is on the resolved *basename* and *segments*, not the raw string,
 * so `./.env` and `docs/../.env` are denied for the same reason `.env` is —
 * a denylist compared against raw text is bypassed by anyone who writes the
 * path a second way, including a model with no idea it was bypassing anything.
 *
 * The `path.normalize` call earns its place in the other direction: it stops
 * `logs/.ssh/../app.log` being refused as if it were inside `.ssh`, when it
 * resolves to `logs/app.log` and is not credential material at all. Traversal
 * cannot *sneak past* the denylist — the basename check sees through it either
 * way — but without normalising, traversal can trip it needlessly, and a
 * denylist that blocks ordinary files is one people route around.
 */
export function isSecretPath(candidate: string): PathVerdict {
  const normalised = path.normalize(candidate).replaceAll('\\', '/');
  const base = path.posix.basename(normalised);
  const segments = normalised.split('/').filter((s) => s.length > 0 && s !== '.');

  for (const directory of DENIED_DIRECTORIES) {
    const parts = directory.split('/');
    for (let i = 0; i + parts.length <= segments.length; i += 1) {
      if (parts.every((part, j) => segments[i + j] === part)) {
        return { denied: true, reason: `${directory}/ holds credential material` };
      }
    }
  }

  if (DENIED_NAMES.has(base)) {
    return { denied: true, reason: `${base} is a credential file` };
  }

  const extension = path.posix.extname(base).toLowerCase();
  if (DENIED_EXTENSIONS.has(extension)) {
    return { denied: true, reason: `${extension} files hold keys or certificates` };
  }

  if (ENV_FILE.test(base) && !ENV_ALLOWED.test(base)) {
    return { denied: true, reason: `${base} is an environment file` };
  }

  return { denied: false, reason: '' };
}
