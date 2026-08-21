#!/usr/bin/env node
/**
 * The release harness (P3-QA-14).
 *
 * Installs a **published** `sdlc-on-fire` from the npm registry into four real
 * project shapes and drives it as a user would. The distinction from every
 * other test in this repo is the artifact: every suite here imports from the
 * workspace, where the sibling packages are simply present, so none of them can
 * see a packaging defect. The hard pin that [P3-PKG-01] found existed only
 * *after* publishing, and only `npm install` from the registry produces it.
 *
 *   node scripts/release-harness/run.mjs                    # latest published
 *   node scripts/release-harness/run.mjs --version 0.1.0-alpha.0
 *   node scripts/release-harness/run.mjs --source local     # pack this workspace instead
 *   node scripts/release-harness/run.mjs --scenario greenfield --keep
 *   node scripts/release-harness/run.mjs --json report.json
 *
 * `--source local` exists so a change can be tested before it is published —
 * publishing is irreversible, and a harness you can only run afterwards is a
 * harness that reports history. It is not the default, and the report records
 * which source was used, because a local pass is weaker evidence than a
 * registry pass and the two must never be confused in a release note.
 *
 * Re-runnable by construction: no state outside a temp directory, no
 * assertions on wording, and a JSON report whose shape is stable across
 * releases so two runs can be diffed rather than re-read.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCENARIOS } from './scenarios.mjs';

const exec = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');

function parseArgs(argv) {
  const options = {
    version: 'latest',
    source: 'registry',
    scenario: null,
    keep: false,
    json: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--keep') options.keep = true;
    else if (arg === '--version') options.version = argv[++i];
    else if (arg === '--source') options.source = argv[++i];
    else if (arg === '--scenario') options.scenario = argv[++i];
    else if (arg === '--json') options.json = argv[++i];
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!['registry', 'local'].includes(options.source)) {
    throw new Error(`--source must be registry or local, got ${options.source}`);
  }
  return options;
}

/** Runs a command, capturing rather than throwing — a non-zero exit is data here. */
async function run(file, args, opts = {}) {
  try {
    const { stdout, stderr } = await exec(file, args, {
      maxBuffer: 64 * 1024 * 1024,
      ...opts,
      env: { ...process.env, ...opts.env },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return {
      code: typeof error.code === 'number' ? error.code : 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? String(error.message ?? error),
    };
  }
}

/**
 * Packs the workspace and returns tarball paths, for `--source local`.
 *
 * `pnpm pack`, not `npm pack`: only pnpm rewrites the `workspace:` protocol,
 * and the rewritten manifest is what actually ships. Packing with npm here
 * would install something no consumer ever receives.
 */
async function packWorkspace(into) {
  const listed = await run('pnpm', ['-r', 'list', '--depth', '-1', '--json'], { cwd: REPO });
  const packages = JSON.parse(listed.stdout).filter((entry) => entry.name !== undefined);
  const tarballs = [];
  for (const entry of packages) {
    if (entry.path === REPO) continue;
    const out = path.join(into, entry.name.replace(/[@/]/g, '_'));
    await fs.mkdir(out, { recursive: true });
    const packed = await run('pnpm', ['pack', '--pack-destination', out], { cwd: entry.path });
    if (packed.code !== 0) throw new Error(`pack failed for ${entry.name}: ${packed.stderr}`);
    const file = (await fs.readdir(out)).find((name) => name.endsWith('.tgz'));
    tarballs.push({ name: entry.name, tarball: path.join(out, file) });
  }
  return tarballs;
}

/** Prepares one scenario's directory: a real repo, real install, real binary. */
async function prepare(scenario, options, tarballs) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `sdlcof-release-${scenario.id}-`));

  if (scenario.clone !== undefined) {
    // Shallow, at a pinned commit. `--depth 1` on a tag keeps a repo with
    // thousands of commits to a few seconds without giving up the pin.
    const cloned = await run('git', [
      'clone',
      '--depth',
      '1',
      '--branch',
      scenario.clone.ref,
      scenario.clone.repo,
      root,
    ]);
    if (cloned.code !== 0) throw new Error(`clone failed: ${cloned.stderr}`);
  } else {
    await run('git', ['init', '-q'], { cwd: root });
    await fs.writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'harness-fixture', version: '0.0.0', private: true }, null, 2),
      'utf8',
    );
  }

  await run('git', ['config', 'user.email', 'harness@example.invalid'], { cwd: root });
  await run('git', ['config', 'user.name', 'Release Harness'], { cwd: root });

  const specs =
    options.source === 'local'
      ? tarballs.map((entry) => entry.tarball)
      : [`sdlc-on-fire@${options.version}`];

  // `--no-audit --no-fund` for output volume only. Scripts are NOT disabled:
  // whether this package installs cleanly with npm's real default is part of
  // what is under test.
  const installed = await run('npm', ['install', '--no-audit', '--no-fund', ...specs], {
    cwd: root,
    timeout: 15 * 60 * 1000,
  });

  return { root, installed };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help === true) {
    process.stdout.write(
      'usage: run.mjs [--version <v>] [--source registry|local] [--scenario <id>] [--json <file>] [--keep]\n',
    );
    return;
  }

  const chosen =
    options.scenario === null
      ? SCENARIOS
      : SCENARIOS.filter((scenario) => scenario.id === options.scenario);
  if (chosen.length === 0) throw new Error(`no scenario named ${options.scenario}`);

  let tarballs = [];
  let packDir = null;
  if (options.source === 'local') {
    packDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sdlcof-release-pack-'));
    process.stdout.write('packing the workspace…\n');
    tarballs = await packWorkspace(packDir);
  }

  const report = {
    version: options.version,
    source: options.source,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    scenarios: [],
  };

  for (const scenario of chosen) {
    process.stdout.write(`\n── ${scenario.id} — ${scenario.title}\n`);
    const started = Date.now();
    let root = null;
    let result;

    try {
      const prepared = await prepare(scenario, options, tarballs);
      root = prepared.root;

      if (prepared.installed.code !== 0) {
        // The single most important failure to report clearly. A release whose
        // dependencies do not resolve from the registry is broken for every
        // user, and it is invisible to every test that imports from the
        // workspace.
        result = {
          id: scenario.id,
          shape: scenario.shape,
          installed: false,
          checks: [
            {
              name: 'npm install succeeds from the registry',
              ok: false,
              detail: prepared.installed.stderr.slice(0, 2000),
            },
          ],
        };
      } else {
        const bin = path.join(root, 'node_modules', '.bin', 'sdlc');
        const ctx = {
          root,
          sdlc: (args) => run(bin, args, { cwd: root, timeout: 5 * 60 * 1000 }),
          git: (args) => run('git', args, { cwd: root }),
        };
        const checks = await scenario.run(ctx);
        result = { id: scenario.id, shape: scenario.shape, installed: true, checks };
      }
    } catch (error) {
      // A throw is a harness bug, and is labelled as one. "The product is
      // broken" and "the test is broken" must never render identically.
      result = {
        id: scenario.id,
        shape: scenario.shape,
        harnessError: String(error && error.message ? error.message : error),
        checks: [],
      };
    } finally {
      if (root !== null && !options.keep) await fs.rm(root, { recursive: true, force: true });
      else if (root !== null) process.stdout.write(`   kept at ${root}\n`);
    }

    result.ms = Date.now() - started;
    report.scenarios.push(result);

    for (const item of result.checks) {
      const mark = item.skipped === true ? '·' : item.ok ? '✓' : '✗';
      process.stdout.write(
        `   ${mark} ${item.name}${item.ok || !item.detail ? '' : ` — ${item.detail}`}\n`,
      );
    }
    if (result.harnessError !== undefined) {
      process.stdout.write(`   ! harness error: ${result.harnessError}\n`);
    }
  }

  if (packDir !== null && !options.keep) await fs.rm(packDir, { recursive: true, force: true });

  const failed = report.scenarios.flatMap((s) =>
    s.checks.filter((c) => !c.ok && c.skipped !== true),
  );
  const skipped = report.scenarios.flatMap((s) => s.checks.filter((c) => c.skipped === true));
  const harnessErrors = report.scenarios.filter((s) => s.harnessError !== undefined);
  report.summary = {
    scenarios: report.scenarios.length,
    checks: report.scenarios.reduce((n, s) => n + s.checks.length, 0),
    failed: failed.length,
    skipped: skipped.length,
    harnessErrors: harnessErrors.length,
  };

  process.stdout.write(
    `\n${report.summary.checks} checks across ${report.summary.scenarios} shapes ` +
      `against ${options.source} ${options.version}: ` +
      `${report.summary.checks - report.summary.failed - report.summary.skipped} passed, ` +
      `${report.summary.failed} failed, ${report.summary.skipped} not in this release.\n`,
  );

  // Skips are printed even though they do not fail the run. A capability absent
  // from a release is a fact about the release, and burying it is how "all
  // green" comes to mean less than it appears to.
  for (const item of skipped) process.stdout.write(`   · ${item.name} — ${item.detail}\n`);

  if (options.json !== null) {
    await fs.writeFile(options.json, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    process.stdout.write(`report written to ${options.json}\n`);
  }

  if (failed.length > 0 || harnessErrors.length > 0) process.exitCode = 1;
}

await main();
