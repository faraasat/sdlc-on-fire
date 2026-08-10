import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  renderPrBody,
  LifecycleEngine,
  SyncEngine,
  gatesMustPassGuard,
} from '@sdlc-on-fire/daemon';
import {
  applySchema,
  provisionPglite,
  PostgresStorageAdapter,
  type ProvisionedDatabase,
} from '@sdlc-on-fire/db';
import {
  defaultV01Policy,
  recordGate,
  replayGate,
  runBuild,
  runTests,
  type GateContext,
} from '@sdlc-on-fire/evidence';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  dispatchSkill,
  IMPLEMENT_SKILL,
  OutputContractError,
  type AgentTransport,
} from '@sdlc-on-fire/agent-manager';
import { init } from './commands.js';
import { buildProgram } from './index.js';

/**
 * The v0.1 walking skeleton, end to end.
 *
 * Every other test in this repo proves one package works. This one proves they
 * **compose** — which is a different claim, and the one that was never made
 * until now. It runs the deterministic spine of the mvp-slice demo:
 *
 *   init → new → sync to the mirror → daemon runs verify → evidence →
 *   evaluateGate blocks on a real failure → lifecycle refuses to advance →
 *   fix → re-verify → gate passes → lifecycle advances → PR body
 *
 * The agent legs run through the real dispatcher (`P1-AGENT-11`) with a stub
 * transport: a fake model, a real contract. Spending tokens would not make the
 * assertion stronger — what is under test is that dispatch fills the template,
 * enforces the output contract, and refuses a self-reported pass.
 */

const HEAD = 'a'.repeat(40);
let root: string;
let db: ProvisionedDatabase;
let sync: SyncEngine;
let lifecycle: LifecycleEngine;
const tempRoots: string[] = [];

const ctx: GateContext = { currentHeadSha: HEAD, now: new Date('2026-08-10T00:00:00.000Z') };

beforeAll(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sdlcof-e2e-')));
  tempRoots.push(root);

  await init(root);
  db = await provisionPglite({ workspaceRoot: root });
  await applySchema(db);
  // Sync reaches data through the port (ADR-0047); the lifecycle engine still
  // takes the executor directly — its own port migration is P0-DB-08 work.
  const port = await PostgresStorageAdapter.create(db);

  sync = new SyncEngine({ workspaceRoot: root, store: port });
  lifecycle = new LifecycleEngine(db);
  lifecycle.registerGuard('gates', gatesMustPassGuard());
}, 120_000);

afterAll(async () => {
  await sync?.stop().catch(() => undefined);
  await db?.close().catch(() => undefined);
  await Promise.all(tempRoots.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

/** A test project the daemon can actually run `verify` against. */
async function writeVerifiableProject(passing: boolean): Promise<void> {
  await fs.writeFile(
    path.join(root, 'run-tests.mjs'),
    passing
      ? 'console.log(JSON.stringify({numTotalTests:2,numPassedTests:2,numFailedTests:0}));\n'
      : `console.log(JSON.stringify({numTotalTests:2,numPassedTests:1,numFailedTests:1,
           testResults:[{name:"a.test.ts",assertionResults:[{fullName:"exports CSV",status:"failed",failureMessages:["expected header row"]}]}]}));\n`,
  );
}

describe('the walking skeleton, end to end', () => {
  it('1 — init scaffolds a workspace the tool recognises', async () => {
    await expect(fs.stat(path.join(root, '.sdlcof', 'config.yaml'))).resolves.toBeDefined();
    await expect(fs.stat(path.join(root, 'kanban', '_inbox'))).resolves.toBeDefined();
  });

  it('2 — `new feature` creates a valid work item on disk', async () => {
    await buildProgram().parseAsync([
      'node',
      'sdlc',
      '-C',
      root,
      'new',
      'feature',
      'Add CSV export',
    ]);
    const raw = await fs.readFile(path.join(root, 'kanban', '_inbox', 'FEAT-001.md'), 'utf8');
    expect(raw).toContain('id: FEAT-001');
    expect(raw).toContain('lifecycle_state: discovery');
  });

  it('3 — the file syncs into the DB mirror', async () => {
    const outcome = await sync.syncFile(path.join(root, 'kanban', '_inbox', 'FEAT-001.md'));
    expect(outcome.action).toBe('upserted');

    const [row] = await db.query<{ id: string; lifecycle_state: string }>(
      "SELECT id, lifecycle_state FROM work_items WHERE id = 'FEAT-001';",
    );
    expect(row).toMatchObject({ id: 'FEAT-001', lifecycle_state: 'discovery' });
  });

  it('4 — the daemon runs verify itself and produces daemon-producer evidence', async () => {
    await writeVerifiableProject(false);
    const evidence = await runTests('node', ['run-tests.mjs'], { cwd: root, gitSha: HEAD });

    // Nobody asked an agent what happened. The daemon ran it and read the output.
    expect(evidence.producer).toBe('daemon');
    expect(evidence.payload).toMatchObject({ ok: false, failed: 1 });
  }, 60_000);

  it('5 — the gate BLOCKS on real failing evidence', async () => {
    await writeVerifiableProject(false);
    const evidence = [
      await runTests('node', ['run-tests.mjs'], { cwd: root, gitSha: HEAD }),
      await runBuild('node', ['-e', '0'], { cwd: root, gitSha: HEAD }),
    ];

    const { verdict } = await recordGate(db, {
      workItemId: 'FEAT-001',
      gateName: 'discovery',
      policy: defaultV01Policy(),
      evidence,
      ctx,
    });

    expect(verdict.pass).toBe(false);
    // Three-way, not binary: tests ran and failed; typecheck never ran.
    expect(verdict.failures).toContain('test failing');
    expect(verdict.missing).toContain('typecheck');
  }, 90_000);

  it('6 — the lifecycle refuses to advance while the gate is failing', async () => {
    const decision = await lifecycle.canTransition('FEAT-001', 'spec');

    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.guard).toBe('gates');

    // And the item genuinely did not move.
    const [row] = await db.query<{ lifecycle_state: string }>(
      "SELECT lifecycle_state FROM work_items WHERE id = 'FEAT-001';",
    );
    expect(row?.lifecycle_state).toBe('discovery');
  });

  it('7 — a real fix produces real passing evidence and the gate opens', async () => {
    await writeVerifiableProject(true);
    const evidence = [
      await runTests('node', ['run-tests.mjs'], { cwd: root, gitSha: HEAD }),
      await runTypecheckStub(),
      await runBuild('node', ['-e', '0'], { cwd: root, gitSha: HEAD }),
    ];

    await db.exec("DELETE FROM gate_evidence; DELETE FROM gates WHERE work_item_id = 'FEAT-001';");
    const { gateId, verdict } = await recordGate(db, {
      workItemId: 'FEAT-001',
      gateName: 'discovery',
      policy: defaultV01Policy(),
      evidence,
      ctx,
    });

    expect(verdict.pass).toBe(true);

    // Replayable from the persisted rows alone — an audit trail, not a claim.
    expect(await replayGate(db, gateId, defaultV01Policy(), ctx)).toEqual(verdict);
  }, 90_000);

  it('8 — the lifecycle now advances, and records the verdict with the transition', async () => {
    await lifecycle.transition({
      workItemId: 'FEAT-001',
      to: 'spec',
      gateResult: { pass: true, missing: [], failures: [] },
    });

    const [row] = await db.query<{ lifecycle_state: string; status: string }>(
      "SELECT lifecycle_state, status FROM work_items WHERE id = 'FEAT-001';",
    );
    expect(row).toMatchObject({ lifecycle_state: 'spec', status: 'Spec' });

    const history = await lifecycle.history('FEAT-001');
    expect(history[0]).toMatchObject({ from: 'discovery', to: 'spec' });
  });

  it('9 — the PR body carries the evidence bundle, not an assertion', async () => {
    await writeVerifiableProject(true);
    const evidence = [await runTests('node', ['run-tests.mjs'], { cwd: root, gitSha: HEAD })];

    const body = renderPrBody({
      workItemId: 'FEAT-001',
      title: 'Add CSV export',
      summary: 'Adds a CSV export button.',
      evidence,
      headSha: HEAD,
      gateVerdict: { pass: true, missing: [], failures: [] },
    });

    expect(body).toContain('## Evidence');
    expect(body).toContain('2/2 passed');
    expect(body).toContain('`daemon`');
    expect(body).toContain('✅ Gate passed.');
  }, 60_000);

  it('9b — the implement skill dispatches and returns a structured result', async () => {
    // The leg that did not exist until P1-AGENT-11: something actually invokes
    // the compiled skill instead of leaving it on disk.
    const transport: AgentTransport = () =>
      Promise.resolve({
        stdout: 'implement_output {"filesChanged":["src/csv.ts"],"summary":"Added CSV export."}',
        stderr: '',
        exitCode: 0,
      });

    const result = await dispatchSkill(
      {
        skill: IMPLEMENT_SKILL,
        variables: { work_item_id: 'FEAT-001', work_item_title: 'Add CSV export' },
        cwd: root,
      },
      transport,
    );

    expect(result.skill).toBe('implement');
    expect(result.output).toMatchObject({ summary: 'Added CSV export.' });
  });

  it('9c — a dispatched agent cannot report its own tests as passing', async () => {
    // Refused at the dispatch boundary, before the claim can reach a run record.
    const lying: AgentTransport = () =>
      Promise.resolve({
        stdout: 'implement_output {"summary":"done","testsPassed":true}',
        stderr: '',
        exitCode: 0,
      });

    await expect(
      dispatchSkill(
        {
          skill: IMPLEMENT_SKILL,
          variables: { work_item_id: 'FEAT-001', work_item_title: 'Add CSV export' },
          cwd: root,
        },
        lying,
      ),
    ).rejects.toBeInstanceOf(OutputContractError);
  });

  it('10 — an agent claiming success cannot open the gate', async () => {
    // The thesis, stated as a test: the daemon will not let the agent lie.
    await writeVerifiableProject(false);
    const real = await runTests('node', ['run-tests.mjs'], { cwd: root, gitSha: HEAD });

    const agentLie = {
      ...real,
      producer: 'agent-claim' as const,
      payload: { ok: true, total: 2, passed: 2, failed: 0, runner: 'vitest', failures: [] },
    };

    await db.exec("DELETE FROM gate_evidence; DELETE FROM gates WHERE work_item_id = 'FEAT-001';");
    const { verdict } = await recordGate(db, {
      workItemId: 'FEAT-001',
      gateName: 'spec',
      policy: defaultV01Policy(),
      evidence: [agentLie],
      ctx,
    });

    expect(verdict.pass).toBe(false);
    expect(verdict.missing).toContain('test');
  }, 60_000);
});

/** tsc is not present in the scratch workspace; a zero-exit stand-in keeps step 7 honest. */
async function runTypecheckStub() {
  const { runTypecheck } = await import('@sdlc-on-fire/evidence');
  return runTypecheck('node', ['-e', '0'], { cwd: root, gitSha: HEAD });
}
