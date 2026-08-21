/**
 * Loading the layers a project installed (P3-PKG-02,
 * `.research/techniques/46`).
 *
 * The pure half — what a manifest must look like, and whether one is
 * admissible — is `@sdlc-on-fire/core`'s `plugin-manifest`. This is the half
 * that cannot be decided: resolving a package from disk and importing it.
 *
 * Two properties are load-bearing and neither is obvious from the code alone:
 *
 * **Only declared dependencies are considered.** The candidate list comes from
 * the project's own `package.json`, never from a directory listing of
 * `node_modules`. Walking the directory would make a package that is present
 * but named by nobody — vendored, checked in, left behind by an earlier
 * install — into loadable code, which is how `git clone && sdlc status` becomes
 * arbitrary code execution (CWE-829; GHSA-99qw-6mr3-36qr). Installing a package
 * you declared already grants it execution at `postinstall`, so this adds no
 * trust boundary; walking the directory would remove one.
 *
 * **A broken plugin is a refusal, not a crash.** A third-party layer that
 * throws while loading must not make `sdlc status` unusable, so every import is
 * isolated and every failure becomes a row in the report.
 */

import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Command } from 'commander';
import { admitPlugin, declaredDependencies, type PluginRefusal } from '@sdlc-on-fire/core';

/** What a plugin's entry module must export, as `plugin` or as its default. */
export interface SdlcPlugin {
  readonly name: string;
  readonly register: (program: Command) => void;
}

export interface LoadedPlugin {
  readonly package: string;
  readonly title: string;
  readonly plugin: SdlcPlugin;
}

/** `load-failed` and `bad-export` are this module's; the rest come from admission. */
export type LoadRefusal = PluginRefusal | 'load-failed' | 'bad-export' | 'unresolvable';

export interface RefusedPlugin {
  readonly package: string;
  readonly refusal: LoadRefusal;
  readonly because: string;
}

export interface PluginDiscovery {
  readonly loaded: readonly LoadedPlugin[];
  /** Only packages that *tried* to be plugins. Ordinary dependencies are not listed. */
  readonly refused: readonly RefusedPlugin[];
  /** How many declared dependencies were examined. */
  readonly examined: number;
}

export interface DiscoverOptions {
  readonly projectRoot: string;
  /** Injected so the loader can be tested without publishing packages. */
  readonly importModule?: (specifier: string) => Promise<unknown>;
}

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
}

/** Whether an imported module exports something shaped like a plugin. */
function pluginFrom(module: unknown): SdlcPlugin | null {
  const candidates = [
    (module as { plugin?: unknown } | null)?.plugin,
    (module as { default?: unknown } | null)?.default,
  ];
  for (const candidate of candidates) {
    if (
      typeof candidate === 'object' &&
      candidate !== null &&
      typeof (candidate as SdlcPlugin).name === 'string' &&
      typeof (candidate as SdlcPlugin).register === 'function'
    ) {
      return candidate as SdlcPlugin;
    }
  }
  return null;
}

/**
 * Find and load every plugin the project at `projectRoot` declares.
 *
 * Order is the sorted dependency order from {@link declaredDependencies}, so
 * command registration is reproducible across runs on one tree.
 */
export async function discoverPlugins(options: DiscoverOptions): Promise<PluginDiscovery> {
  const { projectRoot } = options;
  const loaded: LoadedPlugin[] = [];
  const refused: RefusedPlugin[] = [];

  let hostManifest: unknown;
  try {
    hostManifest = await readJson(path.join(projectRoot, 'package.json'));
  } catch {
    // No package.json is not an error: plenty of workspaces this runs in are
    // not npm projects at all, and they simply have no layers to load.
    return { loaded, refused, examined: 0 };
  }

  const names = declaredDependencies(hostManifest);

  // Resolution is anchored at the project root, so a plugin is found where the
  // project installed it rather than wherever the CLI itself happens to live.
  const require = createRequire(path.join(projectRoot, 'package.json'));

  for (const name of names) {
    let packageRoot: string;
    let manifestPath: string;
    try {
      manifestPath = require.resolve(`${name}/package.json`);
      packageRoot = path.dirname(manifestPath);
    } catch {
      // Declared but not installed, or not exporting its own manifest. Silent:
      // this is ordinary for optional dependencies and for `exports` maps that
      // do not expose `./package.json`, and reporting it would bury the rows
      // that mean something.
      continue;
    }

    let packageJson: unknown;
    try {
      packageJson = await readJson(manifestPath);
    } catch {
      continue;
    }

    const admission = admitPlugin(packageJson);
    if (!admission.admitted) {
      // The common answer, and not a problem: most dependencies are not layers.
      if (admission.refusal === 'not-declared') continue;
      refused.push({ package: name, refusal: admission.refusal, because: admission.because });
      continue;
    }

    const entry = path.resolve(packageRoot, admission.manifest.plugin);
    let module: unknown;
    try {
      module = await (options.importModule ?? ((s: string) => import(s)))(
        entry.startsWith('file:') ? entry : `file://${entry}`,
      );
    } catch (error) {
      refused.push({
        package: name,
        refusal: 'load-failed',
        because: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    const plugin = pluginFrom(module);
    if (plugin === null) {
      refused.push({
        package: name,
        refusal: 'bad-export',
        because: `${admission.manifest.plugin} exports no { name, register } as plugin or default`,
      });
      continue;
    }

    loaded.push({ package: name, title: admission.manifest.title ?? plugin.name, plugin });
  }

  return { loaded, refused, examined: names.length };
}

/**
 * Register every loaded plugin's commands, isolating each one.
 *
 * A plugin that throws in `register` is downgraded to a refusal rather than
 * taking the program down with it — the same reason import is isolated, one
 * step later.
 */
export function registerPlugins(program: Command, discovery: PluginDiscovery): PluginDiscovery {
  const loaded: LoadedPlugin[] = [];
  const refused: RefusedPlugin[] = [...discovery.refused];

  for (const entry of discovery.loaded) {
    try {
      entry.plugin.register(program);
      loaded.push(entry);
    } catch (error) {
      refused.push({
        package: entry.package,
        refusal: 'load-failed',
        because: `register() threw: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  return { loaded, refused, examined: discovery.examined };
}

/**
 * The project root, read from argv before commander has parsed anything.
 *
 * Plugins must be registered *before* `parseAsync`, or their commands do not
 * exist when the argument they were invoked with is looked up — so the value of
 * `-C/--cwd` is needed earlier than commander can supply it. Defaulting to
 * `process.cwd()` instead would silently load the wrong project's layers under
 * `sdlc -C ../other status`, which is the kind of wrong that looks like the
 * layer simply not working.
 *
 * Deliberately not a parser: it recognises the two spellings of one flag and
 * nothing else. Anything more would be a second implementation of commander's
 * argument handling, and two of those disagree eventually.
 */
export function projectRootFromArgv(argv: readonly string[], cwd: string): string {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-C' || arg === '--cwd') {
      const value = argv[i + 1];
      if (value !== undefined && !value.startsWith('-')) return path.resolve(cwd, value);
    }
    if (arg !== undefined && arg.startsWith('--cwd=')) {
      return path.resolve(cwd, arg.slice('--cwd='.length));
    }
  }
  return cwd;
}

/** Human-readable report, shown by `sdlc plugins`. */
export function formatPlugins(discovery: PluginDiscovery): string {
  const lines: string[] = [];

  if (discovery.loaded.length === 0) {
    lines.push(`No layers loaded (${discovery.examined} declared dependencies examined).`);
  } else {
    lines.push(`Loaded ${discovery.loaded.length} layer(s):`);
    for (const entry of discovery.loaded) lines.push(`  ✓ ${entry.package} — ${entry.title}`);
  }

  if (discovery.refused.length > 0) {
    lines.push('');
    // Refusals are printed, always. A layer that declared itself and did not
    // load is the case where silence is worst: the user installed something and
    // is entitled to know it is not running.
    lines.push(`Refused ${discovery.refused.length}:`);
    for (const entry of discovery.refused) {
      lines.push(`  ✗ ${entry.package} [${entry.refusal}] ${entry.because}`);
    }
  }

  return lines.join('\n');
}
