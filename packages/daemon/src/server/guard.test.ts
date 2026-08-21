import { describe, expect, it } from 'vitest';
import { isAllowedOrigin, isLoopbackHost } from './guard.js';

/**
 * P3-UI-01 — the loopback guard.
 *
 * Binding to 127.0.0.1 is not a boundary. DNS rebinding makes a loopback-only
 * server reachable from a hostile page, so the `Host` header — which the page
 * cannot forge, because the browser sets it from the name it resolved — is what
 * actually decides.
 */

describe('isLoopbackHost', () => {
  it('accepts the loopback names, with and without a port', () => {
    for (const host of [
      'localhost',
      'localhost:5173',
      '127.0.0.1',
      '127.0.0.1:8080',
      '[::1]',
      '[::1]:3000',
    ]) {
      expect(isLoopbackHost(host), host).toBe(true);
    }
  });

  it('rejects an attacker-controlled name, which is the entire attack', () => {
    // The rebinding page resolves `evil.com` to 127.0.0.1 but the browser still
    // sends `Host: evil.com`.
    for (const host of ['evil.com', 'evil.com:8080', 'localhost.evil.com', 'notlocalhost']) {
      expect(isLoopbackHost(host), host).toBe(false);
    }
  });

  it('does not treat a name merely containing localhost as loopback', () => {
    // `localhost.evil.com` resolves wherever the attacker wants and a
    // `includes('localhost')` check would wave it straight through.
    expect(isLoopbackHost('localhost.evil.com')).toBe(false);
    expect(isLoopbackHost('evil-localhost')).toBe(false);
    expect(isLoopbackHost('127.0.0.1.evil.com')).toBe(false);
  });

  it('handles an IPv6 literal without mangling it', () => {
    // A naive split(':')[0] turns `[::1]:3000` into `[`, which then matches
    // nothing — the check would fail closed here, but the same bug in the
    // other direction is how allowlists get holes.
    expect(isLoopbackHost('[::1]:3000')).toBe(true);
    expect(isLoopbackHost('[2001:db8::1]:3000')).toBe(false);
  });

  it('rejects absent or empty', () => {
    expect(isLoopbackHost(undefined)).toBe(false);
    expect(isLoopbackHost('')).toBe(false);
  });

  it('is case-insensitive, since the header is not normalised for us', () => {
    expect(isLoopbackHost('LocalHost:5173')).toBe(true);
  });
});

describe('isAllowedOrigin', () => {
  it('allows a loopback origin on any port, because Vite picks its own', () => {
    expect(isAllowedOrigin('http://localhost:5173')).toBe(true);
    expect(isAllowedOrigin('http://127.0.0.1:4173')).toBe(true);
  });

  it('refuses every remote origin', () => {
    // A blanket `*` here would let every page on the internet read the board.
    for (const origin of ['https://evil.com', 'http://localhost.evil.com', 'null']) {
      expect(isAllowedOrigin(origin), origin).toBe(false);
    }
  });

  it('refuses a non-http scheme', () => {
    expect(isAllowedOrigin('file://')).toBe(false);
    expect(isAllowedOrigin('chrome-extension://abc')).toBe(false);
  });

  it('refuses absent, empty, and unparseable', () => {
    expect(isAllowedOrigin(undefined)).toBe(false);
    expect(isAllowedOrigin('')).toBe(false);
    expect(isAllowedOrigin('not a url')).toBe(false);
  });
});
