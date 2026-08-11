import { describe, expect, it } from 'vitest';
import { ENTROPY_THRESHOLD, maskSecret, scanForSecrets, shannonEntropy } from './secret-scan.js';

/**
 * P2-SEC-02 — secret detection.
 *
 * Both directions of being wrong matter, and they are not symmetric. A missed
 * secret is a rotation; a false positive on every config file is a scanner
 * somebody disables, which misses every secret afterwards.
 */

describe('shannonEntropy', () => {
  it('separates a written password from an assigned key', () => {
    // The reference numbers `.research/14` cites for gitleaks' own tuning.
    expect(shannonEntropy('password123')).toBeLessThan(3.5);
    expect(shannonEntropy('wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY')).toBeGreaterThan(4.0);
  });

  it('is zero for a single repeated character and empty input', () => {
    expect(shannonEntropy('aaaaaaaa')).toBe(0);
    expect(shannonEntropy('')).toBe(0);
  });
});

describe('maskSecret', () => {
  it('keeps enough to identify and not enough to use', () => {
    const masked = maskSecret('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789');
    expect(masked.startsWith('ghp_')).toBe(true);
    expect(masked.endsWith('6789')).toBe(true);
    expect(masked).not.toContain('ABCDEFGHIJKLMNOP');
  });

  it('reveals nothing at all from a short value', () => {
    expect(maskSecret('hunter2')).toBe('*******');
  });
});

describe('scanForSecrets — known formats', () => {
  const cases: readonly [string, string, string][] = [
    ['aws-access-key', 'AKIAIOSFODNN7EXAMPLE', 'aws'],
    ['github-token', `ghp_${'a1B2c3D4e5'.repeat(4)}`, 'github'],
    ['stripe-key', 'sk_live_4eC39HqLyjWDarjtT1zdp7dc', 'stripe'],
    ['private-key', '-----BEGIN RSA PRIVATE KEY-----', 'pem'],
    ['url-credentials', 'postgres://admin:s3cr3tpw@db.internal:5432/app', 'dsn'],
  ];

  for (const [rule, sample] of cases) {
    it(`catches ${rule}`, () => {
      const findings = scanForSecrets(`const value = "${sample}";`);
      expect(findings.some((f) => f.rule === rule)).toBe(true);
      expect(findings.every((f) => f.confidence === 'known-format')).toBe(true);
    });
  }

  it('never puts the secret itself in the finding', () => {
    const secret = 'AKIAIOSFODNN7EXAMPLE';
    const [finding] = scanForSecrets(`AWS_KEY=${secret}`);
    // A report that quotes the credential in full copies it into the evidence
    // bundle, the CI log, and the terminal scrollback.
    expect(finding?.preview).not.toBe(secret);
    expect(finding?.preview).toContain('*');
  });

  it('reports every secret in a file, not just the first', () => {
    const findings = scanForSecrets(
      ['AKIAIOSFODNN7EXAMPLE', 'sk_live_4eC39HqLyjWDarjtT1zdp7dc'].join('\n'),
    );
    // A file that leaked one key usually leaked the file it lived in. Stopping
    // at the first turns one fix into a sequence of re-runs.
    expect(findings).toHaveLength(2);
    expect(findings.map((f) => f.line)).toEqual([1, 2]);
  });
});

describe('scanForSecrets — the false-positive direction', () => {
  it('leaves a git SHA alone', () => {
    // 40 hex characters is high-entropy and appears in every log this product
    // writes. A rule keyed on length alone would flag all of them.
    expect(scanForSecrets('commit = "9778648abc1234567890abcdef1234567890abcd"')).toEqual([]);
  });

  it('leaves placeholders in an example config alone', () => {
    const config = [
      'API_KEY=your-api-key-here',
      'SECRET_TOKEN=<replace-me>',
      'PASSWORD=${DB_PASSWORD}',
      'STRIPE_KEY=xxxxxxxxxxxxxxxxxxxxxxxx',
      'AUTH_TOKEN=changeme',
    ].join('\n');
    // `.env.example` is committed on purpose. Flagging it teaches people that
    // this scanner is noise, and a scanner people ignore catches nothing.
    expect(scanForSecrets(config)).toEqual([]);
  });

  it('leaves a placeholder that is long and random-looking alone', () => {
    // Every sample in the test above is rejected on length or entropy before
    // the placeholder list is ever consulted — so that test passes with the
    // placeholder filter deleted, and asserts nothing about it. This one is
    // 31 characters at 4.13 bits/char: it clears both bars, and only the
    // leading `your-` keeps it out of the report.
    expect(shannonEntropy('your-api-key-goes-here-A7bQ9xZ2')).toBeGreaterThan(ENTROPY_THRESHOLD);
    expect(scanForSecrets('API_KEY = "your-api-key-goes-here-A7bQ9xZ2"')).toEqual([]);
    // The same shape without the placeholder prefix is a finding, which is
    // what makes the assertion above about the filter and not about the bars.
    expect(scanForSecrets('API_KEY = "8Kq2mNv9Zx4Rt7Lp3Wc6Yb1Hd5Fg0Js"')).toHaveLength(1);
  });

  it('leaves an empty assignment alone', () => {
    expect(scanForSecrets('API_KEY = ""')).toEqual([]);
  });

  it('leaves ordinary prose alone', () => {
    const prose =
      'The password reset flow sends a token to the user, and the secret key is stored in the vault.';
    expect(scanForSecrets(prose)).toEqual([]);
  });
});

describe('scanForSecrets — entropy layer', () => {
  it('catches a secret-named assignment in no recognised vendor format', () => {
    // The case the known-format list structurally cannot cover: an internal
    // token, or a vendor format published after this file was written.
    const findings = scanForSecrets('INTERNAL_API_KEY = "8Kq2mNv9Zx4Rt7Lp3Wc6Yb1Hd5Fg0Js"');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.confidence).toBe('high-entropy');
    expect(findings[0]?.rule).toContain('INTERNAL_API_KEY');
  });

  it('does not report the same string twice through two layers', () => {
    // A known-format match inside an assignment is one leaked credential, and
    // two findings for it reads as two.
    expect(
      scanForSecrets('GITHUB_TOKEN = "ghp_a1B2c3D4e5a1B2c3D4e5a1B2c3D4e5a1B2c3"'),
    ).toHaveLength(1);
  });

  it('holds an unnamed variable to the higher bar', () => {
    // A long base64-ish string under an innocuous name is usually data. The
    // threshold is what stops every minified asset becoming a finding.
    const low = 'buildId = "aaaaaaaaaaaaaaaaaaaaaaaabbbbbbbb"';
    expect(shannonEntropy('aaaaaaaaaaaaaaaaaaaaaaaabbbbbbbb')).toBeLessThan(ENTROPY_THRESHOLD);
    expect(scanForSecrets(low)).toEqual([]);
  });
});
