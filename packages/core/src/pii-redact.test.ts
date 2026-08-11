import { describe, expect, it } from 'vitest';
import { luhnValid, redactPii } from './pii-redact.js';

/**
 * P2-SEC-04 — personal-data redaction.
 *
 * The failure directions are not symmetric here either, but they invert the
 * secret-scanner's: a missed secret is a rotation, while a missed personal
 * record is somebody's data in a vector store they cannot reach. So detection
 * leans inclusive — bounded by checksums where one exists, because a redactor
 * that mangles every order number is a redactor people switch off.
 */

describe('luhnValid', () => {
  it('accepts real card numbers', () => {
    // Test numbers published by the card networks for exactly this purpose.
    expect(luhnValid('4111111111111111')).toBe(true);
    expect(luhnValid('5500 0000 0000 0004')).toBe(true);
    expect(luhnValid('3400-0000-0000-009')).toBe(true);
  });

  it('rejects a number one digit off', () => {
    expect(luhnValid('4111111111111112')).toBe(false);
  });

  it('rejects things that are merely long', () => {
    expect(luhnValid('1234567890123456')).toBe(false);
    expect(luhnValid('123')).toBe(false);
    expect(luhnValid('abcdefghijklmnop')).toBe(false);
  });
});

describe('redactPii', () => {
  it('redacts an email', () => {
    const result = redactPii('Contact alice@example.com about the order.');
    expect(result.text).toBe('Contact [EMAIL_1] about the order.');
    expect(result.findings[0]?.kind).toBe('email');
  });

  it('redacts a card number that passes Luhn', () => {
    const result = redactPii('Card 4111 1111 1111 1111 was declined.');
    expect(result.text).toContain('[CARD_1]');
    expect(result.text).not.toContain('4111');
  });

  it('leaves a long number that fails Luhn alone', () => {
    // Order numbers, timestamps, and half the identifiers in any log file are
    // sixteen digits. The checksum is what makes this usable.
    const result = redactPii('Order 1234567890123456 shipped.');
    expect(result.text).toBe('Order 1234567890123456 shipped.');
    expect(result.redacted).toBe(false);
  });

  it('redacts an SSN and a phone number', () => {
    const result = redactPii('SSN 123-45-6789, call 555-123-4567.');
    expect(result.text).toContain('[SSN_1]');
    expect(result.text).toContain('[PHONE_1]');
  });

  it('redacts a routable IP but not a private or documentation one', () => {
    const result = redactPii('client 203.0.113.9, gateway 192.168.1.1, peer 8.8.8.8');
    // A private address identifies nobody outside the network it is on, and
    // RFC 5737 documentation ranges belong to nobody at all — redacting them
    // destroys information an agent needs while protecting no one.
    expect(result.text).toContain('192.168.1.1');
    expect(result.text).toContain('203.0.113.9');
    expect(result.text).toContain('[IP_1]');
    expect(result.findings.filter((f) => f.kind === 'ip')).toHaveLength(1);
  });

  it('gives the same value the same token everywhere', () => {
    const result = redactPii('alice@example.com ordered; email alice@example.com to confirm.');
    // An agent debugging "user X's order failed" needs to know two records
    // refer to one person. Collapsing every value to one marker destroys the
    // join and produces an agent that cannot do the task.
    expect(result.text).toBe('[EMAIL_1] ordered; email [EMAIL_1] to confirm.');
    expect(new Set(result.findings.map((f) => f.token)).size).toBe(1);
  });

  it('gives different values different tokens', () => {
    const result = redactPii('alice@example.com and bob@example.com');
    expect(result.text).toBe('[EMAIL_1] and [EMAIL_2]');
  });

  it('does not report one value under two kinds', () => {
    // An email containing digits should not also surface as a passport number.
    const result = redactPii('user A1234567@example.com');
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.kind).toBe('email');
  });

  it('does not corrupt spans when redacting several values on one line', () => {
    const result = redactPii('a@x.com, b@y.com, 4111111111111111, c@z.com');
    // Replacing in place as it goes would shift every subsequent index.
    expect(result.text).toBe('[EMAIL_1], [EMAIL_2], [CARD_1], [EMAIL_3]');
  });

  it('reports the line, so a reviewer can find it', () => {
    const result = redactPii(['first line', 'second line', 'mail alice@example.com'].join('\n'));
    expect(result.findings[0]?.line).toBe(3);
  });

  it('leaves ordinary text untouched', () => {
    const text = 'The parser reads version 1.2.3 and writes to ./dist at 10:30.';
    const result = redactPii(text);
    expect(result.text).toBe(text);
    expect(result.redacted).toBe(false);
  });

  it('leaves a semver string alone despite looking like an IP', () => {
    expect(redactPii('upgraded to 1.2.3').redacted).toBe(false);
  });

  it('handles empty input', () => {
    expect(redactPii('')).toEqual({ text: '', findings: [], redacted: false });
  });
});
