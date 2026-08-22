/**
 * Watcher delivery latency — a BENCHMARK, not a test.
 *
 * Moved out of `src/` on 2026-08-22 because the test glob was collecting it.
 * Its only assertion is `native.length === 8`, which is a restatement of the
 * loop bound above it: the file cannot fail for the reason it exists, and a
 * green run of it said nothing about latency. Meanwhile it started two full
 * `serve()` instances and synced sixteen files on every `pnpm check`, under a
 * ten-minute timeout.
 *
 * It is kept because the measurement is genuinely useful — native FSEvents
 * against forced polling is the comparison behind the watcher's configuration.
 * Run it deliberately:
 *
 *     npx vitest run --config vitest.config.ts packages/cli/bench/watcher-latency.bench.ts
 *
 * If it is ever wanted as a real test, it needs a threshold somebody is willing
 * to defend on CI hardware — and a latency threshold that flakes is worse than
 * no test, so that is a decision rather than an edit.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { init } from './commands.js';
import { serve } from './serve.js';

/** Measures write→onSynced latency directly, with serve() startup paid once. */
async function measure(usePolling: boolean, samples: number): Promise<number[]> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lat-'));
  await init(root);
  let fire: ((id: string) => void) | undefined;
  const server = await serve({
    root,
    port: 0,
    usePolling,
    awaitWriteFinishMs: 50,
    onSynced: (o) => fire?.(o.relativePath),
  });
  const out: number[] = [];
  for (let i = 0; i < samples; i += 1) {
    const id = `FEAT-${String(700 + i)}`;
    const seen = new Promise<void>((resolve) => {
      fire = (p) => {
        if (p.endsWith(`${id}.md`)) resolve();
      };
    });
    const file = path.join(root, 'kanban', '_inbox', `${id}.md`);
    const t0 = Date.now();
    await fs.writeFile(
      file,
      `---\nid: ${id}\nkind: feature\ntitle: t\nstatus: Discovery\nlifecycle_state: discovery\nwork_type: feature\npreset: standard\n---\n\nbody\n`,
      'utf8',
    );
    await seen;
    out.push(Date.now() - t0);
  }
  await server.close();
  await fs.rm(root, { recursive: true, force: true });
  return out;
}

const stat = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return `min=${s[0]}ms med=${s[Math.floor(s.length / 2)]}ms max=${s[s.length - 1]}ms`;
};

describe('watcher delivery latency', () => {
  it('native FSEvents vs forced polling', async () => {
    const native = await measure(false, 8);
    const polling = await measure(true, 8);
    console.log(`  NATIVE (what the old test raced):  ${stat(native)}  ${JSON.stringify(native)}`);
    console.log(
      `  POLLING (what the fix forces):     ${stat(polling)}  ${JSON.stringify(polling)}`,
    );
    expect(native.length).toBe(8);
  }, 600_000);
});
