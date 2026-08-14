import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * An ordinary repository — the synthetic half of ADR-0064's stopgap.
 *
 * ADR-0064's complaint about dogfooding is that a tool validated only against
 * itself gets tuned to its own unusual shape. Ours is a docs-heavy TypeScript
 * monorepo built by agents with a hand-made harness, and nothing about it is
 * ordinary. So this builds what an ordinary project looks like, deliberately
 * including the parts our own repo does not have:
 *
 * - **A real test suite that really fails.** Not a stub returning a non-zero
 *   exit — a `node --test` run with one genuinely broken assertion, because the
 *   evidence gate's whole job is reading a runner's output and the interesting
 *   failures are in the reading.
 * - **Messy history.** Several commits, one of them a merge, so anything
 *   walking the log meets a shape a linear agent-built history never produces.
 *   The revert guard and the change-window checks both read history.
 * - **No `.sdlc/` and no conventions of ours.** The point is `init` on a repo
 *   that has never heard of us.
 * - **Files in the wrong places.** A stray `src/legacy/` with no tests, a
 *   config at the root, a doc that links to a file somebody deleted.
 *
 * The ADR is explicit that this is "a stopgap, not a substitute" for a real
 * pilot with a real maintainer, and it is used here as one: it makes the gate's
 * behaviour reproducible, and it cannot report friction honestly because there
 * is nobody in it.
 */

export interface OrdinaryRepo {
  readonly root: string;
  readonly headSha: string;
}

const FILES: Record<string, string> = {
  'package.json': JSON.stringify(
    {
      name: 'ordinary-app',
      version: '1.4.2',
      type: 'module',
      scripts: { test: 'node --test test/' },
      dependencies: { express: '^4.19.2', pg: '^8.11.5' },
      devDependencies: { eslint: '^9.0.0' },
    },
    null,
    2,
  ),
  'src/orders.js': [
    'export function total(lines) {',
    '  return lines.reduce((sum, line) => sum + line.price * line.qty, 0);',
    '}',
    '',
    'export function discount(total, code) {',
    "  if (code === 'HALF') return total / 2;",
    '  return total;',
    '}',
    '',
  ].join('\n'),
  // No tests touch this, on purpose: an ordinary repo has a corner nobody
  // covers, and a coverage delta that never meets one is not a real check.
  'src/legacy/pricing.js': [
    'export function legacyPrice(cents) {',
    '  return Math.round(cents / 100);',
    '}',
    '',
  ].join('\n'),
  'test/orders.test.js': [
    "import { test } from 'node:test';",
    "import assert from 'node:assert';",
    "import { total, discount } from '../src/orders.js';",
    '',
    "test('totals the lines', () => {",
    '  assert.equal(total([{ price: 10, qty: 2 }]), 20);',
    '});',
    '',
    "test('halves with the code', () => {",
    "  assert.equal(discount(20, 'HALF'), 10);",
    '});',
    '',
  ].join('\n'),
  'README.md': ['# ordinary-app', '', 'See [the design notes](docs/design.md).', ''].join('\n'),
  '.gitignore': 'node_modules\n',
};

/** The failing test, added separately so a caller can choose to have it. */
export const FAILING_TEST = [
  "import { test } from 'node:test';",
  "import assert from 'node:assert';",
  "import { discount } from '../src/orders.js';",
  '',
  "test('an unknown code leaves the total alone', () => {",
  '  // Genuinely wrong: `discount` returns the total unchanged, and this',
  '  // expects it halved. The gate has to read a runner saying so.',
  "  assert.equal(discount(20, 'NOPE'), 10);",
  '});',
  '',
].join('\n');

async function write(root: string, files: Record<string, string>): Promise<void> {
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(root, relative);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, 'utf8');
  }
}

const git = async (root: string, args: string[]): Promise<string> =>
  (await run('git', args, { cwd: root })).stdout;

/**
 * Builds the repository on disk, with history.
 *
 * `realpath` on the temp dir because macOS hands back `/var/...` for a
 * `/private/var/...` directory, and git reports the resolved one — a comparison
 * between the two fails for a reason that has nothing to do with the code.
 */
export async function ordinaryRepo(
  options: { readonly failing?: boolean } = {},
): Promise<OrdinaryRepo> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ordinary-')));

  await git(root, ['init', '-q', '-b', 'main']);
  await git(root, ['config', 'user.email', 'maintainer@ordinary.test']);
  await git(root, ['config', 'user.name', 'A Maintainer']);

  await write(root, FILES);
  await git(root, ['add', '-A']);
  await git(root, ['commit', '-qm', 'initial import']);

  // A branch and a merge, so the history has a shape a linear agent-built one
  // never produces.
  await git(root, ['checkout', '-q', '-b', 'feat/discounts']);
  await write(root, {
    'src/orders.js': `${FILES['src/orders.js'] ?? ''}export const CODES = ['HALF'];\n`,
  });
  await git(root, ['add', '-A']);
  await git(root, ['commit', '-qm', 'add the discount code list']);
  await git(root, ['checkout', '-q', 'main']);
  await git(root, ['merge', '-q', '--no-ff', 'feat/discounts', '-m', 'merge discounts']);

  if (options.failing === true) {
    await write(root, { 'test/discount.test.js': FAILING_TEST });
    await git(root, ['add', '-A']);
    await git(root, ['commit', '-qm', 'a test that does not pass']);
  }

  return { root, headSha: (await git(root, ['rev-parse', 'HEAD'])).trim() };
}
