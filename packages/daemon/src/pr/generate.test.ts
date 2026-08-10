import type { EvidenceEnvelope } from '@sdlc-on-fire/core';
import { describe, expect, it } from 'vitest';
import { renderPrBody, renderPrTitle, summariseEvidence } from './generate.js';

const HEAD = 'a'.repeat(40);

function envelope(over: Partial<EvidenceEnvelope> = {}): EvidenceEnvelope {
  return {
    kind: 'test',
    producer: 'daemon',
    git_sha: HEAD,
    env: { tool_versions: {}, os: 'darwin' },
    command: { cmd: 'pnpm', args: ['test'], cwd: '/x', exit_code: 0 },
    content_hash: 'b'.repeat(64),
    confidence: 0.95,
    produced_at: '2026-08-10T00:00:00.000Z',
    // `report: 'parsed'` is what distinguishes a counted suite from a command
    // that merely exited 0 — without it the row now says so, which is the point.
    payload: { ok: true, passed: 5, total: 5, report: 'parsed' },
    ...over,
  };
}

describe('evidence summary', () => {
  it('reports pass/total for a test envelope', () => {
    expect(summariseEvidence([envelope()], HEAD)[0]).toMatchObject({
      ok: true,
      detail: '5/5 passed',
    });
  });

  it('flags evidence from another commit as stale', () => {
    // A reviewer should see that evidence exists but no longer applies — which
    // is different from no evidence at all.
    expect(summariseEvidence([envelope({ git_sha: 'c'.repeat(40) })], HEAD)[0]?.stale).toBe(true);
  });
});

describe('PR body', () => {
  const base = {
    workItemId: 'FEAT-001',
    title: 'Add CSV export',
    summary: 'Adds a CSV export button.',
    headSha: HEAD,
  };

  it('renders the evidence table', () => {
    const body = renderPrBody({ ...base, evidence: [envelope()] });
    expect(body).toContain('## Evidence');
    expect(body).toContain('5/5 passed');
    expect(body).toContain('✅ pass');
  });

  it('says plainly when nothing was verified', () => {
    const body = renderPrBody({ ...base, evidence: [] });
    expect(body).toContain('has not been verified');
  });

  it('labels agent-claim evidence as non-gating', () => {
    const body = renderPrBody({ ...base, evidence: [envelope({ producer: 'agent-claim' })] });
    expect(body).toContain('non-gating');
  });

  it('separates missing from failing in the gate section', () => {
    // "Run the check" and "fix the code" are different asks.
    const body = renderPrBody({
      ...base,
      evidence: [envelope()],
      gateVerdict: { pass: false, missing: ['build'], failures: ['test failing'] },
    });
    expect(body).toContain('**Missing** (run these): build');
    expect(body).toContain('**Failing** (fix these): test failing');
  });

  it('renders acceptance criteria when present', () => {
    const body = renderPrBody({
      ...base,
      evidence: [envelope()],
      acceptanceCriteria: ['GIVEN a report WHEN exporting THEN a CSV downloads'],
    });
    expect(body).toContain('## Acceptance criteria');
  });

  it('ends with exactly one trailing newline', () => {
    const body = renderPrBody({ ...base, evidence: [envelope()] });
    expect(body.endsWith('\n')).toBe(true);
    expect(body.endsWith('\n\n')).toBe(false);
  });
});

describe('PR title', () => {
  it('scopes to the work item for git log --grep', () => {
    expect(renderPrTitle('FEAT-001', 'Add CSV export')).toBe('feat(FEAT-001): Add CSV export');
  });
});

describe('an unread check cannot look like a passing one (v007)', () => {
  it('says plainly that nothing counted a test', () => {
    // "0/0 passed" read as a healthy row, so an honest eight-test suite and a
    // fabricated `echo PASS` rendered identically and a careful reviewer had no
    // signal at all.
    const row = summariseEvidence(
      [envelope({ payload: { ok: true, passed: 0, total: 0, report: 'exit-code-only' } })],
      HEAD,
    )[0];
    expect(row?.detail).toMatch(/NO TEST COUNT OBSERVED/);
  });

  it('still reports a real count when there is one', () => {
    expect(summariseEvidence([envelope()], HEAD)[0]?.detail).toBe('5/5 passed');
  });
});
