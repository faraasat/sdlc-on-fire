import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AuditParseError,
  parseDependencyAudit,
  summariseAudit,
  type DependencyAudit,
} from './dependency-audit.js';

/**
 * Dependency-audit evidence (P1-GATE-10).
 *
 * The fixture is a **real** `pnpm audit --json` report from this repository,
 * trimmed to two advisories. A hand-written sample would only prove the parser
 * matches my idea of the format, which is exactly the assumption most likely to
 * be wrong — and the two dialects (`advisories` vs `vulnerabilities`) are the
 * kind of difference nobody guesses correctly.
 */

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__');
const realReport = fs.readFileSync(path.join(fixtureDir, 'pnpm-audit.json'), 'utf8');

describe('reading a real pnpm report', () => {
  const audit: DependencyAudit = parseDependencyAudit(realReport);

  it('takes the counts from the tool own metadata, not a recount', () => {
    // One advisory can affect several packages, so a recount would quietly
    // disagree with what the tool printed to the user's terminal.
    expect(audit.counts.high).toBe(3);
    expect(audit.counts.moderate).toBe(1);
    expect(audit.counts.low).toBe(1);
    expect(audit.total_dependencies).toBeGreaterThan(0);
  });

  it('keeps each advisory identifiable', () => {
    const first = audit.advisories[0];
    expect(first?.module).toBe('esbuild');
    expect(first?.url).toMatch(/^https:\/\/github\.com\/advisories\//);
    expect(first?.patched_versions).not.toBe('');
  });

  it('marks an advisory dev-only only when every path is a dev path', () => {
    // One runtime path is enough to make it a runtime risk. `.some()` here would
    // understate it, and the whole value of the field is that it distinguishes
    // a risk to the build machine from a risk to the user.
    expect(audit.advisories.every((advisory) => advisory.dev_only)).toBe(true);
  });

  it('records that it did not gate, in the data', () => {
    // A future policy change should be visible in the evidence rather than only
    // in the code that read it — evidence that does not say whether it gated
    // cannot be replayed honestly.
    expect(audit.advisory_only).toBe(true);
  });
});

describe('the npm dialect', () => {
  it('reads a `vulnerabilities`-shaped report too', () => {
    const npmReport = JSON.stringify({
      vulnerabilities: {
        lodash: {
          name: 'lodash',
          severity: 'high',
          range: '<4.17.21',
          via: [{ title: 'Prototype pollution', url: 'https://example.test/a', range: '<4.17.21' }],
        },
      },
      metadata: { vulnerabilities: { high: 1 }, dependencies: { total: 12 } },
    });

    const audit = parseDependencyAudit(npmReport, 'npm audit');
    expect(audit.advisories[0]?.module).toBe('lodash');
    expect(audit.advisories[0]?.severity).toBe('high');
    // npm's report does not distinguish dev paths here, so it is recorded false
    // rather than guessed. An invented distinction is worse than a missing one.
    expect(audit.advisories[0]?.dev_only).toBe(false);
  });
});

describe('refusing what it cannot read', () => {
  it('rejects output that is not JSON', () => {
    expect(() => parseDependencyAudit('audit failed: network')).toThrow(AuditParseError);
  });

  it('rejects JSON that is not an audit report', () => {
    expect(() => parseDependencyAudit('{"hello":"world"}')).toThrow(/is this an audit report/);
  });
});

describe('the summary line', () => {
  it('reads differently for a clean audit than for an ignored one', () => {
    // A clean audit and an unread one look identical if the wording is careless.
    const clean = parseDependencyAudit(
      JSON.stringify({ advisories: {}, metadata: { vulnerabilities: {}, totalDependencies: 40 } }),
    );
    expect(summariseAudit(clean)).toMatch(/no advisories across 40 dependencies/);
    expect(summariseAudit(parseDependencyAudit(realReport))).toMatch(/does not block/);
  });
});
