import { z } from 'zod';

/**
 * The evidence envelope, per contracts/03-evidence-and-gates.md §2 and ADR-0030.
 *
 * This is the product's core differentiator: gates require real evidence, not
 * self-report. Two guarantees in here are explicitly **not** deferrable to a
 * later phase, because retrofitting them would break the trust model of every
 * gate result already recorded (contract §7):
 *
 *   1. `producer: "agent-claim"` is structurally excluded from pass/fail.
 *   2. Staleness is re-checked against current HEAD.
 */

const SHA1_HEX = /^[0-9a-f]{40}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * All eleven enumerated kinds ship in the enum from day one even though v0.1
 * only implements parsers for `test`, `typecheck`, and `build` (contract §7).
 * A kind added later would be a breaking change to persisted rows; an unused
 * enum member costs nothing.
 */
export const EVIDENCE_KINDS = [
  'test',
  'coverage-delta',
  'e2e',
  'lint',
  'typecheck',
  'build',
  'security-scan',
  'knowledge-claim',
  'mutation-score',
  'flakiness-repeat',
  'mock-density',
] as const;
export const EvidenceKindSchema = z.enum(EVIDENCE_KINDS);
export type EvidenceKind = z.infer<typeof EvidenceKindSchema>;

/** Kinds with a typed payload in v0.1. The rest carry an opaque payload until their parser lands. */
export const V0_1_EVIDENCE_KINDS = ['test', 'typecheck', 'build'] as const;

/**
 * Trust tier, not a free-text source label (contract §2).
 *
 * `agent-claim` is representable so an agent's self-report can still be *shown*
 * to a reviewer — it is excluded from the pass/fail computation structurally,
 * never merely by policy.
 */
export const EVIDENCE_PRODUCERS = ['ci', 'daemon', 'human', 'agent-claim'] as const;
export const EvidenceProducerSchema = z.enum(EVIDENCE_PRODUCERS);
export type EvidenceProducer = z.infer<typeof EvidenceProducerSchema>;

export const TestEvidenceSchema = z.object({
  runner: z.string().min(1),
  total: z.number().int().nonnegative(),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  ok: z.boolean(),
  failures: z
    .array(
      z.object({
        file: z.string(),
        title: z.string(),
        message: z.string(),
      }),
    )
    .default([]),
});

export const TypecheckEvidenceSchema = z.object({
  tool: z.string().min(1),
  ok: z.boolean(),
  errorCount: z.number().int().nonnegative(),
  errors: z
    .array(
      z.object({
        file: z.string(),
        line: z.number().int().nonnegative(),
        message: z.string(),
      }),
    )
    .default([]),
});

export const BuildEvidenceSchema = z.object({
  cmd: z.string().min(1),
  exit_code: z.number().int(),
  ok: z.boolean(),
  durationMs: z.number().nonnegative(),
});

export type TestEvidence = z.infer<typeof TestEvidenceSchema>;
export type TypecheckEvidence = z.infer<typeof TypecheckEvidenceSchema>;
export type BuildEvidence = z.infer<typeof BuildEvidenceSchema>;

export const CommandSchema = z.object({
  cmd: z.string().min(1),
  args: z.array(z.string()),
  cwd: z.string().min(1),
  exit_code: z.number().int(),
});

export const EvidenceEnvSchema = z.object({
  tool_versions: z.record(z.string(), z.string()),
  os: z.string().min(1),
});

/**
 * The fixed wrapper every evidence row carries, regardless of kind.
 *
 * One envelope = one kind. A test run producing both pass/fail counts and a
 * coverage report is two envelopes, never one merged blob — that keeps per-kind
 * lookup simple and each kind independently expirable (contract §2).
 */
export const EvidenceEnvelopeSchema = z.object({
  kind: EvidenceKindSchema,
  producer: EvidenceProducerSchema,
  /** The commit this evidence was produced against. Required even on dirty-tree evidence. */
  git_sha: z.string().regex(SHA1_HEX, 'git_sha must be a 40-character lowercase hex SHA'),
  /** Present only when the command ran against an uncommitted worktree. */
  dirty_tree_hash: z.string().regex(SHA256_HEX).optional(),
  env: EvidenceEnvSchema,
  command: CommandSchema.optional(),
  /** sha256 over the canonical (stable-key-order) JSON serialization of `payload`. */
  content_hash: z.string().regex(SHA256_HEX, 'content_hash must be a sha256 hex digest'),
  signature: z.string().optional(),
  confidence: z.number().min(0).max(1),
  produced_at: z.iso.datetime(),
  expires_at: z.iso.datetime().optional(),
  payload: z.unknown(),
});

export type EvidenceEnvelope = z.infer<typeof EvidenceEnvelopeSchema>;

/** Producer-tier base confidence (contract §2). `agent-claim` is floored at 0. */
export const PRODUCER_BASE_CONFIDENCE: Record<EvidenceProducer, number> = {
  ci: 0.95,
  daemon: 0.95,
  human: 0.9,
  'agent-claim': 0,
};

/**
 * Whether this envelope may contribute to a gate's pass/fail computation.
 *
 * The single structural exclusion the entire "gates require real evidence"
 * claim rests on. Deliberately a standalone predicate rather than an inline
 * check inside `evaluateGate`, so it is testable on its own and cannot be
 * accidentally skipped by a future caller.
 */
export function isGatingEvidence(envelope: Pick<EvidenceEnvelope, 'producer'>): boolean {
  return envelope.producer !== 'agent-claim';
}

/**
 * Producer-tier base score adjusted by freshness (contract §2).
 *
 * `agent-claim` returns 0 regardless of freshness — the floor is what makes it
 * structurally non-gating, not the base score alone.
 */
export function computeConfidence(input: {
  producer: EvidenceProducer;
  produced_at: string;
  expires_at?: string | undefined;
  now?: Date | undefined;
}): number {
  const base = PRODUCER_BASE_CONFIDENCE[input.producer];
  if (base === 0) return 0;
  if (input.expires_at === undefined) return base;

  const produced = Date.parse(input.produced_at);
  const expires = Date.parse(input.expires_at);
  const now = (input.now ?? new Date()).getTime();
  if (Number.isNaN(produced) || Number.isNaN(expires) || expires <= produced) return base;

  const stalenessRatio = (now - produced) / (expires - produced);
  return base * Math.max(0, 1 - stalenessRatio);
}

/**
 * Whether an envelope is past its TTL. A policy marking a kind `require_fresh`
 * treats an expired envelope as *missing*, not merely low-confidence
 * (contract §5.3) — hence a boolean rather than a confidence adjustment.
 */
export function isExpired(
  envelope: Pick<EvidenceEnvelope, 'expires_at'>,
  now: Date = new Date(),
): boolean {
  if (envelope.expires_at === undefined) return false;
  const expires = Date.parse(envelope.expires_at);
  return !Number.isNaN(expires) && now.getTime() > expires;
}

/**
 * Whether the evidence still describes the tree it is being applied to.
 *
 * Evidence produced against a different commit is stale by definition; evidence
 * carrying a `dirty_tree_hash` is stale unless that uncommitted state is
 * byte-identical too, because the tree it measured no longer exists otherwise.
 */
export function isStale(
  envelope: Pick<EvidenceEnvelope, 'git_sha' | 'dirty_tree_hash'>,
  head: { git_sha: string; dirty_tree_hash?: string | undefined },
): boolean {
  if (envelope.git_sha !== head.git_sha) return true;
  if (envelope.dirty_tree_hash === undefined) return head.dirty_tree_hash !== undefined;
  return envelope.dirty_tree_hash !== head.dirty_tree_hash;
}
