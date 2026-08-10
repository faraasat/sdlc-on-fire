import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applySchema, provisionPglite, type ProvisionedDatabase } from '@sdlc-on-fire/db';
import { GENAI_SPANS, runSpans, TOKEN_USAGE_METRIC, tokenUsage } from './otel.js';

/**
 * OTel GenAI span adapter (P1-MET-01).
 *
 * The adapter's job is to be *thin* — a projection of what the DB already
 * holds, never a second record of what happened. These tests are mostly about
 * not lying: an unfinished run must not report success, and our own identifiers
 * must not squat in convention fields that mean something else.
 */

let db: ProvisionedDatabase;
let root: string;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'otel-'));
  db = await provisionPglite({ workspaceRoot: root });
  await applySchema(db);

  await db.query(
    `INSERT INTO work_items (id, type, title, status, lifecycle_state, file_path, content_hash)
     VALUES ('FEAT-1','feature','Export','In Progress','implement','kanban/f.md','h');`,
  );
  await db.query(
    `INSERT INTO runs (id, work_item_id, skill_id, agent_target, model, status, started_at, finished_at)
     VALUES ('run-1','FEAT-1','implement','claude-code','claude-sonnet-4-5','pass', now() - interval '5 minutes', now()),
            ('run-2','FEAT-1','review','claude-code','claude-opus-4-1','fail', now() - interval '3 minutes', now()),
            ('run-3','FEAT-1','spec','claude-code','claude-sonnet-4-5','running', now(), NULL);`,
  );
}, 120_000);

afterAll(async () => {
  await db.close();
  await fs.rm(root, { recursive: true, force: true });
});

describe('run spans', () => {
  it('emits the convention span name', async () => {
    const spans = await runSpans(db);
    expect(spans.every((span) => span.name === GENAI_SPANS.invokeAgent)).toBe(true);
  });

  it('maps a passing run to ok and a failing run to error', async () => {
    const spans = await runSpans(db);
    const byRun = new Map(spans.map((span) => [span.attributes['sdlcof.run.id'], span]));
    expect(byRun.get('run-1')?.status).toBe('ok');
    expect(byRun.get('run-2')?.status).toBe('error');
  });

  it('leaves an unfinished run unset rather than optimistic', async () => {
    // A span reporting success before the work finished is how trace data
    // starts lying, and it lies in the direction nobody checks.
    const spans = await runSpans(db);
    const running = spans.find((span) => span.attributes['sdlcof.run.id'] === 'run-3');
    expect(running?.status).toBe('unset');
    expect(running?.endTimeUnixNano).toBeNull();
  });

  it('uses convention attribute names so a stock dashboard works unmapped', async () => {
    const spans = await runSpans(db);
    const span = spans.find((s) => s.attributes['sdlcof.run.id'] === 'run-1');
    expect(span?.attributes['gen_ai.operation.name']).toBe('invoke_agent');
    expect(span?.attributes['gen_ai.request.model']).toBe('claude-sonnet-4-5');
  });

  it('keeps our identifiers out of convention fields', async () => {
    // A work item id is not a conversation id. Squeezing it into one corrupts
    // any tool that takes the convention seriously.
    const spans = await runSpans(db);
    for (const span of spans) {
      expect(span.attributes).not.toHaveProperty('gen_ai.conversation.id');
      expect(span.attributes['sdlcof.work_item.id']).toBe('FEAT-1');
    }
  });

  it('does not invent a start time it does not have', async () => {
    const spans = await runSpans(db);
    for (const span of spans) {
      expect(Number.isFinite(span.startTimeUnixNano)).toBe(true);
    }
  });
});

describe('token usage', () => {
  it('reports the reserved metric name', async () => {
    await db.query(
      `INSERT INTO token_budgets (scope, scope_id, window_start, window_end, limit_tokens, used_tokens)
       VALUES ('agent','agent-a', now() - interval '1 hour', now() + interval '1 hour', 10000, 2500);`,
    );
    const usage = await tokenUsage(db);
    expect(usage[0]?.name).toBe(TOKEN_USAGE_METRIC);
    expect(usage[0]?.value).toBe(2500);
  });

  it('labels the token type rather than implying a split it does not have', async () => {
    // Input and output price differently; summing them into an unlabelled
    // number produces a figure that looks like cost and is not.
    const usage = await tokenUsage(db);
    expect(usage[0]?.attributes['gen_ai.token.type']).toBe('total');
  });
});
