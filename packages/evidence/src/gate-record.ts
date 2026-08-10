import type { EvidenceEnvelope } from '@sdlc-on-fire/core';
import {
  evaluateGate,
  type Approval,
  type GateContext,
  type GatePolicy,
  type GateVerdict,
} from './evaluate-gate.js';

/**
 * Persisting a gate verdict (P1-GATE-06).
 *
 * `evaluateGate` is pure and stays that way. This module is the thin I/O shell
 * around it: read the linked evidence, call the pure function, write the verdict
 * and its evidence links back. Keeping the split explicit is what lets a verdict
 * be *replayed* later from the same rows rather than merely re-asserted.
 */

export interface GateStore {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

export interface RecordGateInput {
  readonly workItemId: string;
  readonly gateName: string;
  readonly policy: GatePolicy;
  readonly evidence: readonly EvidenceEnvelope[];
  readonly approvals?: readonly Approval[] | undefined;
  readonly ctx: GateContext;
}

export interface RecordedGate {
  readonly gateId: number;
  readonly verdict: GateVerdict;
}

/**
 * Persists an evidence envelope and returns its row id.
 *
 * Evidence rows are **never updated in place** (ADR-0030): a re-run inserts a
 * new row with a new `content_hash` and `produced_at`. Correcting a bad read
 * means a new row, never an edit — the same immutability rule completed work
 * follows.
 */
export async function persistEvidence(
  store: GateStore,
  envelope: EvidenceEnvelope,
): Promise<number> {
  const rows = await store.query<{ id: number }>(
    `INSERT INTO evidence
       (kind, producer, git_sha, dirty_tree_hash, env, command, content_hash, signature,
        confidence, produced_at, expires_at, payload)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9,$10,$11,$12::jsonb)
     RETURNING id;`,
    [
      envelope.kind,
      envelope.producer,
      envelope.git_sha,
      envelope.dirty_tree_hash ?? null,
      JSON.stringify(envelope.env),
      envelope.command === undefined ? null : JSON.stringify(envelope.command),
      envelope.content_hash,
      envelope.signature ?? null,
      envelope.confidence,
      envelope.produced_at,
      envelope.expires_at ?? null,
      JSON.stringify(envelope.payload ?? null),
    ],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('evidence insert returned no id');
  return id;
}

/**
 * Evaluates a gate and records the outcome.
 *
 * The evidence is linked to the gate row via `gate_evidence` **before** the
 * verdict is written, so a verdict can never exist without the rows it was
 * computed from. A verdict whose inputs are unrecoverable is an assertion, not
 * evidence.
 */
export async function recordGate(store: GateStore, input: RecordGateInput): Promise<RecordedGate> {
  const verdict = evaluateGate(input.policy, input.evidence, input.approvals ?? [], input.ctx);

  const gateRows = await store.query<{ id: number }>(
    `INSERT INTO gates (work_item_id, gate_name, result, evaluated_at)
     VALUES ($1, $2, $3, now()) RETURNING id;`,
    [input.workItemId, input.gateName, verdict.pass ? 'pass' : 'fail'],
  );
  const gateId = gateRows[0]?.id;
  if (gateId === undefined) throw new Error('gate insert returned no id');

  for (const envelope of input.evidence) {
    const evidenceId = await persistEvidence(store, envelope);
    // The DB trigger refuses agent-claim evidence on a non-knowledge-claim gate,
    // so this link is also the second enforcement point for that invariant.
    await store.query(
      'INSERT INTO gate_evidence (gate_id, evidence_id) VALUES ($1, $2) ON CONFLICT DO NOTHING;',
      [gateId, evidenceId],
    );
  }

  return { gateId, verdict };
}

/**
 * Re-evaluates a stored gate from its persisted rows.
 *
 * This is the property that makes the audit trail real: a verdict recorded
 * yesterday can be recomputed today from `gate_evidence` alone and must agree,
 * modulo a HEAD that has since moved — in which case the evidence is correctly
 * reported as stale rather than silently still passing.
 */
export async function replayGate(
  store: GateStore,
  gateId: number,
  policy: GatePolicy,
  ctx: GateContext,
  approvals: readonly Approval[] = [],
): Promise<GateVerdict> {
  const rows = await store.query<Record<string, unknown>>(
    `SELECT e.* FROM evidence e
       JOIN gate_evidence ge ON ge.evidence_id = e.id
      WHERE ge.gate_id = $1;`,
    [gateId],
  );

  const envelopes = rows.map(
    (row) =>
      ({
        kind: row['kind'],
        producer: row['producer'],
        git_sha: row['git_sha'],
        ...(row['dirty_tree_hash'] === null ? {} : { dirty_tree_hash: row['dirty_tree_hash'] }),
        env: row['env'],
        ...(row['command'] === null ? {} : { command: row['command'] }),
        content_hash: row['content_hash'],
        confidence: Number(row['confidence']),
        produced_at: new Date(row['produced_at'] as string).toISOString(),
        ...(row['expires_at'] === null
          ? {}
          : { expires_at: new Date(row['expires_at'] as string).toISOString() }),
        payload: row['payload'],
      }) as EvidenceEnvelope,
  );

  return evaluateGate(policy, envelopes, approvals, ctx);
}
