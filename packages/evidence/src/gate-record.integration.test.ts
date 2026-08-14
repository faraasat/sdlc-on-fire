import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { EvidenceEnvelope } from '@sdlc-on-fire/core';
import { applySchema, provisionPglite, type ProvisionedDatabase } from '@sdlc-on-fire/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { defaultV01Policy, type GateContext } from './evaluate-gate.js';
import { persistEvidence, recordGate, replayGate } from './gate-record.js';

/**
 * Teardown retries, because Windows keeps a file locked while anything holds it.
 *
 * A child process that has just exited can still own its handles for a moment,
 * and removing the directory then fails with EBUSY — which Vitest reports as a
 * failed suite even though every assertion in it passed. Retrying is the
 * documented remedy, and is a no-op on platforms without the problem.
 */
const RM_RETRY = { maxRetries: 5, retryDelay: 100 } as const;

/**
 * Persists gates and evidence against the real schema, then replays them.
 *
 * Replay is the property under test: a verdict recorded once must be
 * recomputable from `gate_evidence` alone. That is what makes it an audit trail
 * rather than a claim about one, and only real rows can demonstrate it.
 */

const HEAD = 'a'.repeat(40);
let db: ProvisionedDatabase;
const tempRoots: string[] = [];
const ctx: GateContext = { currentHeadSha: HEAD, now: new Date('2026-08-10T00:00:00.000Z') };

function envelope(over: Partial<EvidenceEnvelope> = {}): EvidenceEnvelope {
  return {
    kind: 'test',
    producer: 'daemon',
    git_sha: HEAD,
    env: { tool_versions: { node: 'v24' }, os: 'darwin' },
    command: { cmd: 'pnpm', args: ['test'], cwd: '/x', exit_code: 0 },
    content_hash: 'b'.repeat(64),
    confidence: 0.95,
    produced_at: '2026-08-09T00:00:00.000Z',
    payload: { ok: true, total: 1, passed: 1 },
    ...over,
  } as unknown as EvidenceEnvelope;
}

const allThree = [envelope(), envelope({ kind: 'typecheck' }), envelope({ kind: 'build' })];

beforeAll(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sdlcof-gate-'));
  tempRoots.push(root);
  db = await provisionPglite({ workspaceRoot: root });
  await applySchema(db);
}, 90_000);

afterAll(async () => {
  await db.close().catch(() => undefined);
  await Promise.all(
    tempRoots.splice(0).map((d) => fs.rm(d, { recursive: true, force: true, ...RM_RETRY })),
  );
});

beforeEach(async () => {
  await db.exec(
    'DELETE FROM gate_evidence; DELETE FROM gates; DELETE FROM evidence; DELETE FROM work_items;',
  );
  await db.query(
    `INSERT INTO work_items (id, type, title, status, lifecycle_state, work_type, preset, file_path, content_hash)
     VALUES ('TASK-001','task','t','In Progress','implement','feature','standard','kanban/t.md','h');`,
  );
});

describe('persisting evidence', () => {
  it('round-trips an envelope through the table', async () => {
    const id = await persistEvidence(db, envelope());
    const [row] = await db.query<{ kind: string; producer: string; content_hash: string }>(
      'SELECT kind, producer, content_hash FROM evidence WHERE id = $1;',
      [id],
    );
    expect(row).toMatchObject({ kind: 'test', producer: 'daemon' });
  });

  it('inserts a new row per re-run rather than updating in place', async () => {
    // ADR-0030: correcting a bad read means a new row, never an edit.
    await persistEvidence(db, envelope({ produced_at: '2026-08-09T00:00:00.000Z' }));
    await persistEvidence(db, envelope({ produced_at: '2026-08-09T12:00:00.000Z' }));

    const rows = await db.query<{ count: number }>('SELECT count(*)::int AS count FROM evidence;');
    expect(rows[0]?.count).toBe(2);
  });
});

describe('recording a gate', () => {
  it('writes the verdict and links its evidence', async () => {
    const { gateId, verdict } = await recordGate(db, {
      workItemId: 'TASK-001',
      gateName: 'implement',
      policy: defaultV01Policy(),
      evidence: allThree,
      ctx,
    });

    expect(verdict.pass).toBe(true);

    const [gate] = await db.query<{ result: string }>('SELECT result FROM gates WHERE id = $1;', [
      gateId,
    ]);
    expect(gate?.result).toBe('pass');

    const links = await db.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM gate_evidence WHERE gate_id = $1;',
      [gateId],
    );
    expect(links[0]?.count).toBe(3);
  });

  it('records a failing verdict as fail', async () => {
    const { gateId } = await recordGate(db, {
      workItemId: 'TASK-001',
      gateName: 'implement',
      policy: defaultV01Policy(),
      evidence: [envelope({ payload: { ok: false } })],
      ctx,
    });
    const [gate] = await db.query<{ result: string }>('SELECT result FROM gates WHERE id = $1;', [
      gateId,
    ]);
    expect(gate?.result).toBe('fail');
  });
});

describe('replay', () => {
  it('recomputes the same verdict from the persisted rows alone', async () => {
    // The property that makes this an audit trail rather than an assertion.
    const { gateId, verdict } = await recordGate(db, {
      workItemId: 'TASK-001',
      gateName: 'implement',
      policy: defaultV01Policy(),
      evidence: allThree,
      ctx,
    });

    expect(await replayGate(db, gateId, defaultV01Policy(), ctx)).toEqual(verdict);
  });

  it('reports the evidence as stale once HEAD moves', async () => {
    const { gateId } = await recordGate(db, {
      workItemId: 'TASK-001',
      gateName: 'implement',
      policy: defaultV01Policy(),
      evidence: allThree,
      ctx,
    });

    const moved = { ...ctx, currentHeadSha: 'c'.repeat(40) };
    const replayed = await replayGate(db, gateId, defaultV01Policy(), moved);

    // Not silently still passing: the evidence no longer describes this tree.
    expect(replayed.pass).toBe(false);
    expect(replayed.missing).toEqual(['test', 'typecheck', 'build']);
  });
});
