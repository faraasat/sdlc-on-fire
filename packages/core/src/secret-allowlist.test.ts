import { describe, expect, it } from 'vitest';
import {
  hasInlineAllow,
  isAllowlistedPath,
  isAllowlistedValue,
  parseSecretAllowlist,
} from './secret-allowlist.js';
import { scanForSecrets } from './secret-scan.js';

/**
 * P2-SEC-02 — the secret-scan allowlist.
 *
 * Written after dogfooding `sdlc scan` on this repo blocked it on 20 of its
 * own test fixtures and buried the result under 540 lockfile hashes.
 */

const CONFIG = `
# Secret-scan configuration.
title = "sdlc-on-fire"

[extend]
useDefault = true

[allowlist]
description = "Fixtures and documented examples."
paths = [
  '''packages/db/src/connected\\.test\\.ts''',
  '''packages/core/src/secret-scan\\.test\\.ts''',
]
regexes = [
  # A comment inside the array.
  '''postgres://user:password@''',
  '''AKIAIOSFODNN7EXAMPLE''',
]
`;

describe('parseSecretAllowlist', () => {
  it('reads both arrays out of the [allowlist] section', () => {
    const allowlist = parseSecretAllowlist(CONFIG);
    expect(allowlist.paths).toHaveLength(2);
    expect(allowlist.regexes).toHaveLength(2);
  });

  it('matches the paths it read', () => {
    const allowlist = parseSecretAllowlist(CONFIG);
    expect(isAllowlistedPath(allowlist, 'packages/db/src/connected.test.ts')).toBe(true);
    expect(isAllowlistedPath(allowlist, 'packages/db/src/connected.ts')).toBe(false);
  });

  it('ignores keys outside the allowlist section', () => {
    // `[extend]` and `[[rules]]` carry their own `paths`/`regexes`. Reading
    // them as exemptions would turn a detection rule into a blind spot.
    const allowlist = parseSecretAllowlist(`
[[rules]]
id = "custom"
regexes = ['''.*''']

[allowlist]
paths = ['''only\\.this\\.ts''']
`);
    expect(allowlist.regexes).toEqual([]);
    expect(allowlist.paths).toHaveLength(1);
  });

  it('does not treat a # inside a pattern as a comment', () => {
    const allowlist = parseSecretAllowlist(`
[allowlist]
regexes = [ "token#value" ]
`);
    expect(allowlist.regexes[0]?.source).toBe('token#value');
  });

  it('drops an unparseable pattern rather than throwing', () => {
    const allowlist = parseSecretAllowlist(`
[allowlist]
regexes = [ '''valid''', '''(unclosed''' ]
`);
    // One rule fewer means one more finding reported — the safe direction.
    expect(allowlist.regexes).toHaveLength(1);
  });
});

describe('parseSecretAllowlist — fails toward over-blocking', () => {
  const broken = ['', 'not toml at all {{{', '[allowlist]', '[allowlist]\npaths = ['];

  for (const [index, config] of broken.entries()) {
    it(`yields an empty allowlist for malformed input #${String(index)}`, () => {
      // The load-bearing property. A config this reader cannot understand must
      // never become "exempt everything" — a false positive is something a
      // person sees and fixes; a silently permissive allowlist is a real
      // credential nobody hears about.
      const allowlist = parseSecretAllowlist(config);
      expect(allowlist.paths).toEqual([]);
      expect(allowlist.regexes).toEqual([]);
      expect(isAllowlistedPath(allowlist, 'anything.ts')).toBe(false);
      expect(isAllowlistedValue(allowlist, 'AKIAIOSFODNN7EXAMPLE')).toBe(false);
    });
  }
});

describe('isAllowlistedValue', () => {
  it('matches the surrounding line, not only the captured value', () => {
    const allowlist = parseSecretAllowlist(`
[allowlist]
regexes = [ '''postgres://user:password@host:port/database''' ]
`);
    // The detector captures `postgres://user:password@` — the credential-bearing
    // prefix of any DSN — so an allowlist entry written as the full documented
    // placeholder would exempt nothing if only the capture were compared.
    expect(isAllowlistedValue(allowlist, 'postgres://user:password@')).toBe(false);
    expect(
      isAllowlistedValue(
        allowlist,
        'postgres://user:password@',
        'e.g. postgres://user:password@host:port/database',
      ),
    ).toBe(true);
  });
});

describe('hasInlineAllow', () => {
  it('honours gitleaks’ own marker as well as ours', () => {
    // A repo already annotated for gitleaks should not have to be annotated
    // a second time for us.
    expect(hasInlineAllow('const example = "AKIA…"; // gitleaks:allow')).toBe(true);
    expect(hasInlineAllow('const example = "AKIA…"; // sdlc:allow-secret')).toBe(true);
    expect(hasInlineAllow('const real = "AKIA…";')).toBe(false);
  });
});

describe('scanForSecrets with an allowlist', () => {
  it('exempts an allowlisted example value', () => {
    const allowlist = parseSecretAllowlist(CONFIG);
    expect(scanForSecrets('const k = "AKIAIOSFODNN7EXAMPLE";', allowlist)).toEqual([]);
    // A real key of the same shape still blocks — the entry is an exact value,
    // not the pattern that matched it.
    expect(scanForSecrets('const k = "AKIAQ7RZ4L2M9XPWVB3T";', allowlist)).toHaveLength(1);
  });

  it('exempts only the annotated line', () => {
    const content = [
      'const documented = "AKIAIOSFODNN7EXAMPLE"; // gitleaks:allow',
      'const leaked = "AKIAQ7RZ4L2M9XPWVB3T";',
    ].join('\n');
    const findings = scanForSecrets(content);
    // File-level suppression would hide the second line. Annotating a fixture
    // must not blind the scanner to the rest of the file.
    expect(findings).toHaveLength(1);
    expect(findings[0]?.line).toBe(2);
  });

  it('scans normally when given no allowlist', () => {
    expect(scanForSecrets('const k = "AKIAIOSFODNN7EXAMPLE";')).toHaveLength(1);
  });
});
