/**
 * The four project shapes a release is tested against (P3-QA-14).
 *
 * Split from the runner so that *what is tested* is readable without reading
 * *how it is run*, and so a scenario can be added without touching the harness.
 *
 * Each scenario returns checks — `{ name, ok, detail }` — and never throws for
 * an ordinary failure. A scenario that throws is itself a harness bug and is
 * reported as one, which keeps "the product is broken" distinguishable from
 * "the test is broken".
 */

import fs from 'node:fs/promises';
import path from 'node:path';

/** A real commit, resolved from the remote rather than remembered. */
export const OSS_TARGET = {
  repo: 'https://github.com/expressjs/express.git',
  ref: '4.21.2',
  commit: '1faf228935aa0a13111f92c28ee795be64ce3f0f',
};

const check = (name, ok, detail = '') => ({ name, ok: Boolean(ok), detail: String(detail) });

/** Parses `--json` output, returning null rather than throwing on garbage. */
function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function writeProject(root, files) {
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(root, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, body, 'utf8');
  }
}

/** `git status --porcelain` lines, as `XY path` with the status code kept. */
async function touchedFiles(ctx) {
  const status = await ctx.git(['status', '--porcelain']);
  return status.stdout
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line !== '');
}

/**
 * 1 — Greenfield. An empty directory, from nothing.
 *
 * The shape with the least to go wrong and therefore the one whose failure is
 * least ambiguous: if this is red, the release does not work at all.
 */
export const greenfield = {
  id: 'greenfield',
  title: 'A new project, from scratch',
  shape: 'from scratch',
  async run(ctx) {
    const checks = [];
    const init = await ctx.sdlc(['init']);
    checks.push(check('sdlc init exits 0', init.code === 0, init.code === 0 ? '' : init.stderr));

    // The layout is the product's own contract (contracts/06). Asserted as
    // "these exist", not as a full tree comparison: a golden tree would go red
    // on every legitimate addition and get regenerated rather than read.
    for (const entry of ['kanban', '.sdlcof']) {
      const there = await fs
        .stat(path.join(ctx.root, entry))
        .then(() => true)
        .catch(() => false);
      checks.push(check(`init creates ${entry}/`, there));
    }

    const status = await ctx.sdlc(['status', '--json']);
    const parsed = parseJson(status.stdout);
    checks.push(check('status --json exits 0', status.code === 0, status.stderr));
    checks.push(
      check('status --json is parseable JSON', parsed !== null, status.stdout.slice(0, 200)),
    );

    // A capture → triage round trip is the smallest thing that proves the
    // content-in-git half actually wrote something a later command can read.
    const captured = await ctx.sdlc(['capture', 'a first idea']);
    checks.push(check('capture exits 0', captured.code === 0, captured.stderr));

    const listed = await ctx.sdlc(['list', '--json']);
    const items = parseJson(listed.stdout);
    checks.push(
      check(
        'the captured item is readable back',
        Array.isArray(items) ? items.length > 0 : items !== null && Object.keys(items).length > 0,
        listed.stdout.slice(0, 200),
      ),
    );
    return checks;
  },
};

/**
 * 2 — A project of our own devising, adopted mid-flight.
 *
 * Real git history, real source, a real passing test file, and no trace of this
 * product until the moment it is installed. What it exists to catch is the
 * class of assumption that only holds in a directory the product created
 * itself.
 */
export const invented = {
  id: 'invented-midstream',
  title: 'An existing project of our own, adopted mid-flight',
  shape: 'from the middle',
  async run(ctx) {
    const checks = [];

    await writeProject(ctx.root, {
      'src/rates.js': `export function convert(amount, rate) {\n  if (rate <= 0) throw new RangeError('rate must be positive');\n  return Math.round(amount * rate * 100) / 100;\n}\n`,
      'src/rates.test.js': `import { convert } from './rates.js';\nimport { test } from 'node:test';\nimport assert from 'node:assert';\ntest('converts', () => { assert.equal(convert(10, 1.5), 15); });\n`,
      'src/rates.integration.test.js': `import { test } from 'node:test';\ntest('placeholder', () => {});\n`,
      'README.md': '# rates\n\nA currency helper that predates this product.\n',
    });
    await ctx.git(['add', '-A']);
    await ctx.git(['commit', '-m', 'feat: convert with rounding']);
    await ctx.git(['commit', '--allow-empty', '-m', 'chore: a second commit, so history is real']);

    const init = await ctx.sdlc(['init']);
    checks.push(check('adopts a repo it did not create', init.code === 0, init.stderr));

    // It must not have clobbered what was already there.
    const readme = await fs.readFile(path.join(ctx.root, 'README.md'), 'utf8');
    checks.push(
      check('leaves the existing README alone', readme.includes('predates this product')),
    );

    const source = await fs
      .stat(path.join(ctx.root, 'src/rates.js'))
      .then(() => true)
      .catch(() => false);
    checks.push(check('leaves existing source in place', source));

    const tiers = await ctx.sdlc(['tiers', '--json']);
    const report = parseJson(tiers.stdout);
    checks.push(check('tiers --json is parseable', report !== null, tiers.stdout.slice(0, 200)));

    // The P2-QA-07 defect, as a check that outlives it. `sdlc tiers` once
    // synthesised a run from a *file count* and printed "85/85 unit tests
    // passed" for a suite it had never executed. This product exists to refuse
    // that sentence from an agent; it must never emit it about a project it was
    // merely pointed at.
    checks.push(
      check(
        'never claims a discovered tier passed',
        !/\d+\/\d+ \w+ tests passed/.test(tiers.stdout),
        tiers.stdout.slice(0, 300),
      ),
    );
    checks.push(
      check(
        'files alone do not satisfy the requirement',
        report === null || report.report?.satisfied !== true,
        JSON.stringify(report?.report?.satisfied),
      ),
    );
    return checks;
  },
};

/**
 * 3 — A large open-source repository, adopted mid-flight.
 *
 * Not a fixture. Thousands of commits, a directory layout nobody here chose,
 * and a `package.json` written years before this product existed. Pinned to a
 * commit rather than to a branch so that a red result means the release
 * changed, not that upstream did.
 */
export const oss = {
  id: 'oss-midstream',
  title: `A large open-source repo (express@${OSS_TARGET.ref}), adopted mid-flight`,
  shape: 'from the middle',
  clone: OSS_TARGET,
  async run(ctx) {
    const checks = [];

    const head = await ctx.git(['rev-parse', 'HEAD']);
    checks.push(
      check(
        'is pinned to the commit under test',
        head.stdout.trim() === OSS_TARGET.commit,
        `${head.stdout.trim()} != ${OSS_TARGET.commit}`,
      ),
    );

    // Read-only first, on a repository that has never heard of this product.
    const tiers = await ctx.sdlc(['tiers', '--json']);
    checks.push(
      check(
        'tiers runs on a foreign repo',
        tiers.code === 0 || tiers.code === 1,
        tiers.stderr.slice(0, 300),
      ),
    );
    checks.push(
      check(
        'tiers emits parseable JSON',
        parseJson(tiers.stdout) !== null,
        tiers.stdout.slice(0, 200),
      ),
    );
    checks.push(
      check(
        'still refuses to say a discovered tier passed',
        !/\d+\/\d+ \w+ tests passed/.test(tiers.stdout),
        tiers.stdout.slice(0, 300),
      ),
    );

    // Measured *before* init, because `npm install` has already edited
    // package.json by this point. The first version of this check attributed
    // that edit to the product and reported a defect that did not exist — the
    // harness accusing the thing it was installing of a change the harness
    // itself made.
    const before = new Set(await touchedFiles(ctx));

    const init = await ctx.sdlc(['init']);
    checks.push(check('adopts a large foreign repo', init.code === 0, init.stderr.slice(0, 400)));

    const after = await touchedFiles(ctx);
    const byInit = after.filter((entry) => !before.has(entry));

    // Adoption must be additive. A tool that rearranges a stranger's repository
    // on first run is one nobody runs twice. Appending its own ignore rule is
    // the one exception, and it is allowed only as an append — a rewritten
    // .gitignore would drop rules the project depends on.
    const modified = byInit
      .filter((entry) => entry.startsWith('M') || entry.startsWith('D'))
      .map((entry) => entry.slice(2).trim());
    const beyondIgnore = modified.filter((file) => file !== '.gitignore');
    checks.push(
      check(
        'modifies or deletes nothing that was already tracked, beyond .gitignore',
        beyondIgnore.length === 0,
        beyondIgnore.join(', '),
      ),
    );

    const numstat = await ctx.git(['diff', '--numstat', '--', '.gitignore']);
    const deletions = Number(numstat.stdout.trim().split(/\s+/)[1] ?? '0');
    checks.push(
      check(
        'only appends to .gitignore, never rewrites it',
        deletions === 0,
        numstat.stdout.trim(),
      ),
    );

    checks.push(
      check(
        'adds something, rather than doing nothing',
        byInit.length > 0,
        byInit.slice(0, 5).join(', '),
      ),
    );
    return checks;
  },
};

/**
 * 4 — Bare install, then a second layer added afterwards.
 *
 * The founder's extendability requirement, stated as a test: somebody on the
 * bare `sdlc-on-fire` package who later adopts another layer must get it,
 * without a release of the CLI in between.
 *
 * Gated on a **capability probe**, not on a version number. Plugin support
 * landed in P3-PKG-02 and is not in every published release; probing what the
 * installed binary can actually do keeps this honest against old releases
 * without hardcoding a version that then goes stale.
 */
export const extension = {
  id: 'layer-extension',
  title: 'A bare install, extended by a layer installed afterwards',
  shape: 'from scratch, then extended',
  async run(ctx) {
    const checks = [];

    // Probed by reading the command list, not by running `sdlc plugins --help`
    // and checking the exit code. That was the first version and it was a false
    // positive: commander answers `--help` for an *unknown* command by printing
    // top-level help and exiting 0, so the probe reported the capability as
    // present on a release that does not have it — and the two checks below
    // then failed as regressions rather than being reported as absent. Verified
    // directly against the published 0.1.0-alpha.0.
    const help = await ctx.sdlc(['--help']);
    const present = /^\s+plugins\b/m.test(help.stdout);
    if (!present) {
      return [
        {
          name: 'plugin discovery is present in this release',
          ok: false,
          skipped: true,
          detail:
            'this release predates P3-PKG-02 — `sdlc plugins` is not in the command list, so a ' +
            'layer installed afterwards cannot be discovered. Not a regression; not a pass either.',
        },
      ];
    }
    checks.push(check('plugin discovery is present in this release', true));

    const layer = path.join(ctx.root, 'node_modules', '@harness', 'demo-layer');
    await fs.mkdir(layer, { recursive: true });
    await writeProject(layer, {
      'package.json': JSON.stringify({
        name: '@harness/demo-layer',
        version: '1.0.0',
        type: 'module',
        'sdlc-on-fire': { api: 1, plugin: './plugin.js', title: 'Harness layer' },
      }),
      'plugin.js': `export const plugin = { name: 'harness-demo', register(program) { program.command('harness-demo').action(() => process.stdout.write('layer ran\\n')); } };`,
    });

    // Declared, because discovery reads declared dependencies and never lists
    // node_modules — which is the point of the next check.
    const manifestPath = path.join(ctx.root, 'package.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    manifest.dependencies = { ...manifest.dependencies, '@harness/demo-layer': '1.0.0' };
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

    const listed = await ctx.sdlc(['plugins']);
    checks.push(
      check(
        'the layer is discovered',
        listed.stdout.includes('@harness/demo-layer'),
        listed.stdout.slice(0, 300),
      ),
    );

    const ran = await ctx.sdlc(['harness-demo']);
    checks.push(
      check(
        "the layer's command runs, with no release of the CLI",
        ran.code === 0 && ran.stdout.includes('layer ran'),
        `code=${ran.code} ${ran.stderr.slice(0, 200)}`,
      ),
    );

    // The security property, on the installed artifact rather than in a unit
    // test: a package present on disk and declared by nobody is not executed.
    const sneaky = path.join(ctx.root, 'node_modules', '@harness', 'undeclared');
    await fs.mkdir(sneaky, { recursive: true });
    await writeProject(sneaky, {
      'package.json': JSON.stringify({
        name: '@harness/undeclared',
        version: '1.0.0',
        type: 'module',
        'sdlc-on-fire': { api: 1, plugin: './plugin.js' },
      }),
      'plugin.js': `process.stdout.write('UNDECLARED-CODE-RAN\\n');\nexport const plugin = { name: 'u', register() {} };`,
    });

    const after = await ctx.sdlc(['plugins']);
    checks.push(
      check(
        'an undeclared package on disk is never executed',
        !after.stdout.includes('UNDECLARED-CODE-RAN') &&
          !after.stderr.includes('UNDECLARED-CODE-RAN'),
        'CWE-829: declared dependencies only',
      ),
    );
    return checks;
  },
};

export const SCENARIOS = [greenfield, invented, oss, extension];
