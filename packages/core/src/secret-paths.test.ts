import { describe, expect, it } from 'vitest';
import { isSecretPath } from './secret-paths.js';

/**
 * P2-SEC-02 — the secret-path denylist.
 *
 * The cheapest control in the security layer: it does not need to recognise a
 * secret, only where secrets live. A token in a format nobody has seen is
 * invisible to a scanner and still sits in `.env`.
 */

describe('isSecretPath — denied', () => {
  const denied = [
    '.env',
    '.env.local',
    '.env.production.local',
    'config/.env',
    'id_rsa',
    '.ssh/id_ed25519',
    'certs/server.pem',
    'private.key',
    'keystore.p12',
    '.aws/credentials',
    '.npmrc',
    '.kube/config',
    'service-account.json',
  ];

  for (const candidate of denied) {
    it(`refuses ${candidate}`, () => {
      const verdict = isSecretPath(candidate);
      expect(verdict.denied).toBe(true);
      // The reason is what a person sees when a tool refuses to read a file.
      expect(verdict.reason).not.toBe('');
    });
  }

  it('is not fooled by a second spelling of the same path', () => {
    // A denylist matched against raw strings is bypassed by anyone who writes
    // the path differently — including a model with no idea it was bypassing
    // anything.
    expect(isSecretPath('./.env').denied).toBe(true);
    expect(isSecretPath('docs/../.env').denied).toBe(true);
    expect(isSecretPath('a/b/../../.ssh/id_rsa').denied).toBe(true);
  });

  it('resolves traversal before matching a directory segment', () => {
    // These three cases pass with or without normalisation — the basename and
    // segment checks see through `..` on their own. What normalisation
    // actually buys is the case below, which is why it is tested separately
    // rather than assumed to be covered by the ones above.
    expect(isSecretPath('logs/.ssh/../app.log').denied).toBe(false);
  });

  it('refuses a Windows-separated path too', () => {
    expect(isSecretPath('config\\.env').denied).toBe(true);
  });
});

describe('isSecretPath — allowed', () => {
  const allowed = [
    '.env.example',
    '.env.sample',
    '.env.template',
    'src/index.ts',
    'README.md',
    'docs/environment.md',
    'package.json',
    'keys.ts',
    'test/fixtures/env-parser.test.ts',
  ];

  for (const candidate of allowed) {
    it(`allows ${candidate}`, () => {
      expect(isSecretPath(candidate).denied).toBe(false);
    });
  }

  it('allows .env.example specifically, and it matters', () => {
    // Committed on purpose, placeholders by definition, and often the one file
    // an agent needs in order to write correct configuration. Denying it
    // teaches people the denylist is noise.
    expect(isSecretPath('.env.example').denied).toBe(false);
    expect(isSecretPath('.env.local').denied).toBe(true);
  });
});
