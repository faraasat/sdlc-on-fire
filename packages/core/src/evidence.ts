import { z } from 'zod';
import { expectedGapPp } from './held-out.js';

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
  /**
   * A review someone actually performed (P1-GATE-03 hardening, from v007).
   *
   * A review *is* evidence about a change, so it lives with the rest rather than
   * in a parallel structure — which means it inherits per-item scoping, the
   * staleness re-check, and the rule that `agent-claim` can never gate.
   */
  'review',
  'knowledge-claim',
  'mutation-score',
  'flakiness-repeat',
  'mock-density',
  /**
   * A provider check run's verdict (P6-SURFACE-07, FEAT-EVID-007).
   *
   * Its own kind rather than a `producer: 'ci'` instance of `test`, because a
   * check run reports **a verdict, not a measurement** — GitHub's Checks API
   * returns a status and a conclusion and nothing about what ran. Squeezing
   * that into `TestEvidence` would mean writing `total: 0, passed: 0` beside
   * `ok: true`, which is a fabricated number wearing the shape of a real one.
   * A *parsed* CI artifact is still `kind: test, producer: ci`; there the
   * numbers exist. Contract 03 §3.
   */
  'ci-status',
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

/**
 * GitHub's own vocabulary, not a normalised one.
 *
 * Renaming `timed_out` to `timeout` on the way in would mean the evidence row
 * and the provider's UI disagree about what happened, and the person reading
 * the row is about to go and look at that UI. Cited: GitHub REST — check runs,
 * fetched 2026-08-30.
 */
export const CI_CHECK_STATUSES = ['queued', 'in_progress', 'completed'] as const;
export const CI_CHECK_CONCLUSIONS = [
  'success',
  'failure',
  'neutral',
  'cancelled',
  'skipped',
  'timed_out',
  'action_required',
] as const;

/**
 * Which conclusions count as a pass.
 *
 * `neutral` and `skipped` are **not** passes. Both mean the check declined to
 * judge, and a gate that reads "the check did not run" as "the check approved"
 * is the failure this whole subsystem exists to prevent — it is also the most
 * likely one, since a skipped job is the normal result of a path filter.
 */
export const PASSING_CI_CONCLUSIONS: ReadonlySet<string> = new Set(['success']);

export const CiStatusEvidenceSchema = z.object({
  provider: z.string().min(1),
  /** The check run's name, as the provider reports it. */
  check: z.string().min(1),
  status: z.enum(CI_CHECK_STATUSES),
  conclusion: z.enum(CI_CHECK_CONCLUSIONS),
  /** Where a person goes to see it. */
  url: z.string().min(1).optional(),
  head_sha: z.string().regex(SHA1_HEX),
  ok: z.boolean(),
});

export type CiStatusEvidence = z.infer<typeof CiStatusEvidenceSchema>;

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
/**
 * How a model was invoked, recorded on any verdict a model authored
 * (P1-GATE-09, FEAT-EVID-014).
 *
 * Without this, two contradictory verdicts on the same diff are
 * indistinguishable — same prompt, same code, different answer, and no way to
 * tell whether the model changed, the temperature changed, or the model is
 * simply non-deterministic. A verdict you cannot attribute is a verdict you
 * cannot re-examine.
 *
 * `model` carries a version, not a family name: "the reviewer" is not
 * reproducible six months later, and a provider silently re-pointing an alias
 * is exactly the change this is meant to make visible.
 */
export const ModelInvocationSchema = z.object({
  /** Fully qualified, version-pinned identifier. */
  model: z.string().min(1),
  provider: z.string().min(1),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  max_output_tokens: z.number().int().positive().optional(),
  /** Set when the provider reports a seed; makes a run replayable where supported. */
  seed: z.number().int().optional(),
});
export type ModelInvocation = z.infer<typeof ModelInvocationSchema>;

export const EvidenceEnvelopeSchema = z.object({
  kind: EvidenceKindSchema,
  producer: EvidenceProducerSchema,
  /** The commit this evidence was produced against. Required even on dirty-tree evidence. */
  git_sha: z.string().regex(SHA1_HEX, 'git_sha must be a 40-character lowercase hex SHA'),
  /** Present only when the command ran against an uncommitted worktree. */
  dirty_tree_hash: z.string().regex(SHA256_HEX).optional(),
  /**
   * Repo-relative paths whose change could alter this verdict (P8-EVID-02).
   *
   * Optional, and its absence means *unknown coverage* rather than *covers
   * nothing* — see {@link scopedStaleness}, where a missing list is stale. Set
   * by the daemon from what the command actually read; an agent-set value would
   * make evidence look fresh by declaring a narrow scope, which is the forgery
   * this envelope exists to prevent.
   */
  covers: z.array(z.string().min(1)).optional(),
  env: EvidenceEnvSchema,
  command: CommandSchema.optional(),
  /** sha256 over the canonical (stable-key-order) JSON serialization of `payload`. */
  content_hash: z.string().regex(SHA256_HEX, 'content_hash must be a sha256 hex digest'),
  signature: z.string().optional(),
  confidence: z.number().min(0).max(1),
  produced_at: z.iso.datetime(),
  expires_at: z.iso.datetime().optional(),
  /**
   * Required when a model authored this evidence, absent otherwise.
   *
   * Enforced below rather than left to convention: a model-authored verdict
   * with no invocation record is unattributable, and the whole point of the
   * envelope is that evidence carries its own provenance.
   */
  model_invocation: ModelInvocationSchema.optional(),
  payload: z.unknown(),
});

export type EvidenceEnvelope = z.infer<typeof EvidenceEnvelopeSchema>;

/** Producers whose output a model wrote, and which therefore must be attributable. */
const MODEL_AUTHORED: ReadonlySet<string> = new Set(['agent-claim']);

/**
 * The envelope, with the model-attribution rule applied.
 *
 * Kept as a separate schema rather than folded into the base so existing
 * non-model evidence keeps parsing unchanged — the rule only bites where a
 * model was involved.
 */
export const AttributedEvidenceEnvelopeSchema = EvidenceEnvelopeSchema.superRefine(
  (envelope, ctx) => {
    if (MODEL_AUTHORED.has(envelope.producer) && envelope.model_invocation === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['model_invocation'],
        message:
          `producer "${envelope.producer}" is model-authored, so model_invocation is required — ` +
          'an unattributable verdict cannot be re-examined (P1-GATE-09)',
      });
    }
  },
);

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
  /**
   * Lines the change under test touches (P3-GATE-11).
   *
   * A green suite over a 30,000-line change is not worth what a green suite
   * over 300 lines is worth, and that is measured rather than felt: the gap
   * between a visible suite's pass rate and a held-out one's grows roughly
   * 27pp per tenfold increase in LOC. Omitted means unknown, and unknown
   * applies no discount — inventing a size would be worse than not knowing one.
   */
  changed_lines?: number | undefined;
}): number {
  const base = PRODUCER_BASE_CONFIDENCE[input.producer];
  if (base === 0) return 0;
  if (input.expires_at === undefined) return base;

  const produced = Date.parse(input.produced_at);
  const expires = Date.parse(input.expires_at);
  const now = (input.now ?? new Date()).getTime();
  if (Number.isNaN(produced) || Number.isNaN(expires) || expires <= produced) return base;

  const stalenessRatio = (now - produced) / (expires - produced);
  return sizeDiscounted(base * Math.max(0, 1 - stalenessRatio), input.changed_lines);
}

/**
 * The change-size discount (P3-GATE-11).
 *
 * Multiplicative on whatever freshness left, and bounded below by
 * {@link MIN_SIZE_DISCOUNT} — a large change's evidence is worth *less*, never
 * nothing. Driving it to zero would make a big change structurally ungateable,
 * which is the opposite of the intent: the point is that the number stops
 * over-claiming, not that the gate stops working.
 */
export const MIN_SIZE_DISCOUNT = 0.5;

export function sizeDiscounted(confidence: number, changedLines: number | undefined): number {
  if (changedLines === undefined) return confidence;
  const gap = expectedGapPp(changedLines);
  if (gap <= 0) return confidence;
  return confidence * Math.max(MIN_SIZE_DISCOUNT, 1 - gap / 100);
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

export const FRESHNESS_VERDICTS = ['current', 'current-by-scope', 'stale'] as const;
export type FreshnessVerdict = (typeof FRESHNESS_VERDICTS)[number];

export interface ScopedStalenessInput {
  /** Whether the policy marks this evidence kind exempt. Opt-in, never a default. */
  readonly scopeExempt: boolean;
  /** Repo-relative paths whose change could alter this verdict. Daemon-produced. */
  readonly covers?: readonly string[] | undefined;
  /** Whether the envelope's commit is still an ancestor of HEAD. */
  readonly ancestor: boolean;
  /**
   * Every path that changed between the envelope's commit and HEAD — **both
   * sides of a rename**, because a file that moved out of the covered set
   * changed it.
   */
  readonly changedPaths: readonly string[];
}

export interface FreshnessResult {
  readonly verdict: FreshnessVerdict;
  readonly because: string;
  /** Covered paths the diff touched. Empty unless the verdict is `stale` for that reason. */
  readonly touched: readonly string[];
}

/**
 * Freshness with a scope exemption for expensive signals (P8-EVID-02, [Q-08]).
 *
 * `isStale` says any commit invalidates. That is right, and for a signal that
 * costs half an hour it is unaffordable: a trivial rebase forces a full
 * mutation re-run over a surface nothing touched, and a check that expensive on
 * every rebase is a check somebody switches off — which is the same abandonment
 * shape [R-08] describes for presets.
 *
 * This also implements what [contracts/03 §5.3] has described since it was
 * written. Its pseudocode calls `isAncestorAndUntouched` — *"no intervening
 * commit touched files the evidence covers"* — and nothing implemented it, so
 * that branch was unreachable prose for the whole build.
 *
 * ## Four conditions, all required, and the default is strict
 *
 * The exemption is **opt-in per kind**. For a cheap signal, re-running is
 * cheaper than reasoning about scope, and a scope rule that is wrong is worse
 * than a re-run.
 *
 * **Ancestry is not a formality.** After a rebase or a force-push the commit
 * the evidence names is not in this history at all, so there is no range to
 * diff and no honest way to say what changed since. That case is stale, and
 * treating it as "sha differs, check the diff" would silently accept evidence
 * about a tree that no longer exists.
 *
 * **`covers` is daemon-produced and never inferred from the diff.** A list that
 * is too narrow is a way to make stale evidence look fresh, which is the exact
 * forgery the envelope exists to prevent. Deriving it from the changed files
 * would make the check circular — it would always pass.
 *
 * An empty or absent `covers` means *unknown coverage*, which is stale rather
 * than universally-fresh: the reassuring reading of a missing field is the one
 * that silently keeps every expensive result forever.
 */
export function scopedStaleness(
  envelope: Pick<EvidenceEnvelope, 'git_sha' | 'dirty_tree_hash'>,
  head: { git_sha: string; dirty_tree_hash?: string | undefined },
  input: ScopedStalenessInput,
): FreshnessResult {
  if (!isStale(envelope, head)) {
    return { verdict: 'current', because: 'evidence names the current tree', touched: [] };
  }

  if (!input.scopeExempt) {
    return {
      verdict: 'stale',
      because: 'the tree moved and this evidence kind is not scope-exempt',
      touched: [],
    };
  }

  // A dirty tree at HEAD is unmeasured change, whatever the diff says: the
  // uncommitted edit is not in any commit range.
  if (head.dirty_tree_hash !== undefined && head.dirty_tree_hash !== envelope.dirty_tree_hash) {
    return {
      verdict: 'stale',
      because: 'the working tree has uncommitted changes, which no commit range can account for',
      touched: [],
    };
  }

  const covers = input.covers ?? [];
  if (covers.length === 0) {
    return {
      verdict: 'stale',
      because:
        'the evidence declares no covered paths, so nothing can be said about what the diff missed',
      touched: [],
    };
  }

  if (!input.ancestor) {
    return {
      verdict: 'stale',
      because: `the commit this evidence names (${envelope.git_sha.slice(0, 8)}) is not an ancestor of HEAD — after a rebase or force-push there is no range to diff`,
      touched: [],
    };
  }

  const covered = new Set(covers);
  const touched = input.changedPaths.filter((changed) => covered.has(changed));
  if (touched.length > 0) {
    return {
      verdict: 'stale',
      because: `${String(touched.length)} covered path(s) changed since ${envelope.git_sha.slice(0, 8)}`,
      touched,
    };
  }

  return {
    verdict: 'current-by-scope',
    because: `${String(input.changedPaths.length)} path(s) changed since ${envelope.git_sha.slice(0, 8)} and none of the ${String(covers.length)} this evidence covers`,
    touched: [],
  };
}
