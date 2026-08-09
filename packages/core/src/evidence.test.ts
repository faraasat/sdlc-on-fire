import { describe, expect, it } from 'vitest';
import {
  computeConfidence,
  EvidenceEnvelopeSchema,
  EVIDENCE_KINDS,
  isExpired,
  isGatingEvidence,
  isStale,
  V0_1_EVIDENCE_KINDS,
} from './evidence.js';

const GIT_SHA = 'a'.repeat(40);
const CONTENT_HASH = 'b'.repeat(64);
const DIRTY_HASH = 'c'.repeat(64);

function validEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'test',
    producer: 'daemon',
    git_sha: GIT_SHA,
    env: { tool_versions: { vitest: '4.1.10' }, os: 'darwin' },
    content_hash: CONTENT_HASH,
    confidence: 0.95,
    produced_at: '2026-08-10T00:00:00.000Z',
    payload: { runner: 'vitest', total: 1, passed: 1, failed: 0, ok: true, failures: [] },
    ...overrides,
  };
}

describe('envelope schema', () => {
  it('accepts a well-formed daemon envelope', () => {
    expect(EvidenceEnvelopeSchema.safeParse(validEnvelope()).success).toBe(true);
  });

  it('requires a 40-hex git_sha even on dirty-tree evidence', () => {
    expect(EvidenceEnvelopeSchema.safeParse(validEnvelope({ git_sha: 'HEAD' })).success).toBe(
      false,
    );
    expect(
      EvidenceEnvelopeSchema.safeParse(
        validEnvelope({ dirty_tree_hash: DIRTY_HASH, git_sha: GIT_SHA }),
      ).success,
    ).toBe(true);
  });

  it('requires a sha256 content_hash', () => {
    expect(EvidenceEnvelopeSchema.safeParse(validEnvelope({ content_hash: 'abc' })).success).toBe(
      false,
    );
  });

  it('bounds confidence to 0..1', () => {
    expect(EvidenceEnvelopeSchema.safeParse(validEnvelope({ confidence: 1.5 })).success).toBe(
      false,
    );
    expect(EvidenceEnvelopeSchema.safeParse(validEnvelope({ confidence: -0.1 })).success).toBe(
      false,
    );
  });

  it('ships the full kind enum, not just the v0.1 parsers', () => {
    // Adding a kind later would break persisted rows; unused members cost nothing.
    expect(EVIDENCE_KINDS.length).toBe(11);
    for (const kind of V0_1_EVIDENCE_KINDS) {
      expect(EVIDENCE_KINDS).toContain(kind);
    }
  });
});

describe('agent-claim is structurally excluded', () => {
  it('is representable but never gating', () => {
    // Representable so a reviewer can still see it...
    expect(
      EvidenceEnvelopeSchema.safeParse(validEnvelope({ producer: 'agent-claim' })).success,
    ).toBe(true);
    // ...but excluded from pass/fail regardless of stated confidence.
    expect(isGatingEvidence({ producer: 'agent-claim' })).toBe(false);
  });

  it('scores zero confidence even when fresh', () => {
    expect(
      computeConfidence({ producer: 'agent-claim', produced_at: '2026-08-10T00:00:00.000Z' }),
    ).toBe(0);
  });

  it('lets every other producer gate', () => {
    for (const producer of ['ci', 'daemon', 'human'] as const) {
      expect(isGatingEvidence({ producer })).toBe(true);
    }
  });
});

describe('confidence decay', () => {
  const produced_at = '2026-08-10T00:00:00.000Z';
  const expires_at = '2026-08-10T10:00:00.000Z';

  it('returns the producer base when no TTL is set', () => {
    expect(computeConfidence({ producer: 'daemon', produced_at })).toBe(0.95);
    expect(computeConfidence({ producer: 'human', produced_at })).toBe(0.9);
  });

  it('decays linearly across the TTL window', () => {
    const halfway = computeConfidence({
      producer: 'daemon',
      produced_at,
      expires_at,
      now: new Date('2026-08-10T05:00:00.000Z'),
    });
    expect(halfway).toBeCloseTo(0.475, 5);
  });

  it('floors at zero past expiry rather than going negative', () => {
    const past = computeConfidence({
      producer: 'daemon',
      produced_at,
      expires_at,
      now: new Date('2026-08-11T00:00:00.000Z'),
    });
    expect(past).toBe(0);
  });
});

describe('expiry', () => {
  it('treats a missing expires_at as never expiring', () => {
    expect(isExpired({ expires_at: undefined })).toBe(false);
  });

  it('is false before and true after the cutoff', () => {
    const expires_at = '2026-08-10T10:00:00.000Z';
    expect(isExpired({ expires_at }, new Date('2026-08-10T09:59:00.000Z'))).toBe(false);
    expect(isExpired({ expires_at }, new Date('2026-08-10T10:01:00.000Z'))).toBe(true);
  });
});

describe('staleness against HEAD', () => {
  it('is stale when the commit moved', () => {
    expect(isStale({ git_sha: GIT_SHA }, { git_sha: 'd'.repeat(40) })).toBe(true);
  });

  it('is fresh on a matching clean tree', () => {
    expect(isStale({ git_sha: GIT_SHA }, { git_sha: GIT_SHA })).toBe(false);
  });

  it('is stale when evidence was clean but the tree is now dirty', () => {
    // The tree the evidence measured no longer exists.
    expect(isStale({ git_sha: GIT_SHA }, { git_sha: GIT_SHA, dirty_tree_hash: DIRTY_HASH })).toBe(
      true,
    );
  });

  it('is stale when the dirty tree changed underneath it', () => {
    expect(
      isStale(
        { git_sha: GIT_SHA, dirty_tree_hash: DIRTY_HASH },
        { git_sha: GIT_SHA, dirty_tree_hash: 'e'.repeat(64) },
      ),
    ).toBe(true);
  });

  it('is fresh when the same dirty tree is still in place', () => {
    expect(
      isStale(
        { git_sha: GIT_SHA, dirty_tree_hash: DIRTY_HASH },
        { git_sha: GIT_SHA, dirty_tree_hash: DIRTY_HASH },
      ),
    ).toBe(false);
  });
});
