import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { advanceWorkItem } from './advance.js';
import { init } from './commands.js';

/**
 * The security-review gate, in the actual transition path (P6-PAYLOAD-03).
 *
 * The unit tests cover the verdict. What matters here is that the check is
 * *reached* — because it was not, and nothing said so. `requireSecurityReview`
 * computed the requirement, `sdlc risk` printed "⚠ security review REQUIRED"
 * and exited 0, and `withSecurityReview`/`securityReviewSatisfied` had only test
 * callers. A gate with a passing unit suite and no caller is the shape this
 * repository keeps finding, and a *security* gate in that shape is the worst
 * version of it.
 */
const RM_RETRY = { maxRetries: 5, retryDelay: 100 } as const;
const run = promisify(execFile);
let root: string;

const CARD = [
  '---',
  '$schema: https://sdlc-on-fire.dev/schema/work-item.json',
  'id: FEAT-001',
  'kind: feature',
  'title: Rotate session tokens',
  'status: Inbox',
  'lifecycle_state: implement',
  'work_type: feature',
  'preset: standard',
  'risk_level: low',
  'verify: node -e "process.exit(0)"',
  'done:',
  '  - Tokens MUST rotate on privilege change.',
  'created_at: 2026-08-23T00:00:00.000Z',
  'updated_at: 2026-08-23T00:00:00.000Z',
  '---',
  '',
  'body',
  '',
].join('\n');

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sdlcof-secgate-')));
  await run('git', ['init', '-q'], { cwd: root });
  await run('git', ['config', 'user.email', 't@e.com'], { cwd: root });
  await run('git', ['config', 'user.name', 'T'], { cwd: root });
  await init(root, { database: 'skip' });
  await fs.mkdir(path.join(root, 'kanban', '_inbox'), { recursive: true });
  await fs.writeFile(path.join(root, 'kanban', '_inbox', 'FEAT-001.md'), CARD, 'utf8');
  await run('git', ['add', '-A'], { cwd: root });
  await run('git', ['commit', '-qm', 'base'], { cwd: root });
}, 90_000);

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true, ...RM_RETRY });
});

/** An uncommitted change to a tracked high-risk surface. */
async function touchAuth(): Promise<void> {
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'src', 'auth.ts'),
    'export const login = (p: string) => p === "x";\n',
    'utf8',
  );
  await run('git', ['add', '-A'], { cwd: root });
}

describe('advance and the security-review gate', () => {
  it('refuses to advance a card whose diff touches auth, with no sign-off', async () => {
    await touchAuth();
    const result = await advanceWorkItem(root, 'FEAT-001');
    expect(result.moved).toBe(false);
    expect(result.refusals.join('\n')).toContain('security-review');
    expect(result.refusals.join('\n')).toContain('auth');
  }, 90_000);

  it('names the role that may sign off and the command that records it', async () => {
    await touchAuth();
    const result = await advanceWorkItem(root, 'FEAT-001');
    const text = result.refusals.join('\n');
    // A refusal nobody can act on gets clicked through rather than investigated.
    expect(text).toContain('sdlc gates approve');
    expect(text).toMatch(/security or eng-lead/);
  }, 90_000);

  it('does not mention security at all when the diff touches nothing risky', async () => {
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.writeFile(path.join(root, 'src', 'format.ts'), 'export const n = 1;\n', 'utf8');
    await run('git', ['add', '-A'], { cwd: root });
    const result = await advanceWorkItem(root, 'FEAT-001');
    // It may still be blocked for other reasons — what must not happen is a
    // security refusal on a change that touches no tracked surface, which is how
    // a gate becomes noise people learn to ignore.
    expect(result.refusals.join('\n')).not.toContain('security-review');
  }, 90_000);

  it('does not fire on a clean tree', async () => {
    const result = await advanceWorkItem(root, 'FEAT-001');
    expect(result.refusals.join('\n')).not.toContain('security-review');
  }, 90_000);
});
