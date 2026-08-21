import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { afterEach, describe, expect, it } from 'vitest';
import { SDLC_PLUGIN_API } from '@sdlc-on-fire/core';
import { discoverPlugins, formatPlugins, projectRootFromArgv, registerPlugins } from './plugins.js';

/**
 * P3-PKG-02 — plugin discovery, against real directories and real ESM imports.
 *
 * Mocked here would prove nothing: the defect class this closes is a package
 * that resolves in one layout and not another, and the security property is
 * about which files on disk are reachable. Both are statements about a real
 * filesystem, so the fixtures are real `node_modules` trees and the modules are
 * really imported.
 */

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

interface Fixture {
  readonly name: string;
  readonly manifest?: Record<string, unknown> | null;
  readonly source?: string;
  /** Present on disk but absent from the host's package.json. */
  readonly undeclared?: boolean;
}

async function project(fixtures: readonly Fixture[]): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sdlcof-plugins-'));
  roots.push(root);

  const deps: Record<string, string> = {};
  for (const fixture of fixtures) {
    if (fixture.undeclared !== true) deps[fixture.name] = '1.0.0';

    const dir = path.join(root, 'node_modules', ...fixture.name.split('/'));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({
        name: fixture.name,
        version: '1.0.0',
        type: 'module',
        ...(fixture.manifest === null ? {} : { 'sdlc-on-fire': fixture.manifest }),
      }),
      'utf8',
    );
    if (fixture.source !== undefined) {
      await fs.writeFile(path.join(dir, 'plugin.js'), fixture.source, 'utf8');
    }
  }

  await fs.writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'host', version: '0.0.0', dependencies: deps }),
    'utf8',
  );
  return root;
}

const WORKING = `export const plugin = {
  name: 'demo',
  register(program) { program.command('demo').action(() => {}); },
};`;

const ok = { api: SDLC_PLUGIN_API, plugin: './plugin.js' };

describe('discoverPlugins', () => {
  it('loads a declared, well-formed layer and registers its command', async () => {
    // The whole point of the task: adding a capability is an install, not a
    // release of the CLI.
    const root = await project([{ name: 'demo-layer', manifest: ok, source: WORKING }]);
    const discovery = await discoverPlugins({ projectRoot: root });

    expect(discovery.loaded.map((entry) => entry.package)).toEqual(['demo-layer']);
    expect(discovery.refused).toEqual([]);

    const program = new Command();
    registerPlugins(program, discovery);
    expect(program.commands.map((command) => command.name())).toContain('demo');
  });

  it('does not load a package that is installed but undeclared', async () => {
    // The security property, and the reason discovery reads package.json rather
    // than listing node_modules. A package present on disk that nobody declared
    // — vendored, checked in, left by an earlier install — must not be
    // reachable, or `git clone && sdlc status` on a hostile repository is
    // arbitrary code execution under the user's account (CWE-829,
    // GHSA-99qw-6mr3-36qr). The fixture writes a working plugin and simply
    // omits it from `dependencies`.
    const root = await project([
      { name: 'sneaky', manifest: ok, source: WORKING, undeclared: true },
    ]);
    const discovery = await discoverPlugins({ projectRoot: root });

    expect(discovery.loaded).toEqual([]);
    expect(discovery.refused).toEqual([]);
    expect(discovery.examined).toBe(0);
  });

  it('ignores ordinary dependencies without reporting them', async () => {
    // Most dependencies of a project using this product are not layers of it.
    // Listing them as refusals would bury the rows that mean something.
    const root = await project([
      { name: 'lodash', manifest: null },
      { name: 'demo-layer', manifest: ok, source: WORKING },
    ]);
    const discovery = await discoverPlugins({ projectRoot: root });

    expect(discovery.loaded.map((entry) => entry.package)).toEqual(['demo-layer']);
    expect(discovery.refused).toEqual([]);
    expect(discovery.examined).toBe(2);
  });

  it('refuses a layer built against another API, and keeps loading the rest', async () => {
    const root = await project([
      { name: 'aaa-good', manifest: ok, source: WORKING },
      { name: 'zzz-future', manifest: { ...ok, api: SDLC_PLUGIN_API + 1 }, source: WORKING },
    ]);
    const discovery = await discoverPlugins({ projectRoot: root });

    expect(discovery.loaded.map((entry) => entry.package)).toEqual(['aaa-good']);
    expect(discovery.refused.map((entry) => entry.refusal)).toEqual(['api-mismatch']);
  });

  it('survives a layer that throws at import, without taking the CLI down', async () => {
    // A third-party layer must not be able to make `sdlc status` unusable.
    const root = await project([
      { name: 'aaa-good', manifest: ok, source: WORKING },
      { name: 'zzz-broken', manifest: ok, source: `throw new Error('boom at import');` },
    ]);
    const discovery = await discoverPlugins({ projectRoot: root });

    expect(discovery.loaded.map((entry) => entry.package)).toEqual(['aaa-good']);
    expect(discovery.refused[0]?.refusal).toBe('load-failed');
    expect(discovery.refused[0]?.because).toContain('boom at import');
  });

  it('survives a layer that throws while registering', async () => {
    const root = await project([
      {
        name: 'thrower',
        manifest: ok,
        source: `export default { name: 'x', register() { throw new Error('boom at register'); } };`,
      },
    ]);
    const registered = registerPlugins(new Command(), await discoverPlugins({ projectRoot: root }));

    expect(registered.loaded).toEqual([]);
    expect(registered.refused[0]?.refusal).toBe('load-failed');
    expect(registered.refused[0]?.because).toContain('boom at register');
  });

  it('refuses a module that exports nothing plugin-shaped', async () => {
    const root = await project([
      { name: 'empty', manifest: ok, source: `export const unrelated = 1;` },
    ]);
    const discovery = await discoverPlugins({ projectRoot: root });
    expect(discovery.refused[0]?.refusal).toBe('bad-export');
  });

  it('refuses a manifest whose entry climbs out of its package', async () => {
    // Never reaches the filesystem: admission refuses the path, so the escape
    // is not merely unresolvable, it is unattempted.
    const root = await project([
      { name: 'escaper', manifest: { ...ok, plugin: '../../evil.js' }, source: WORKING },
    ]);
    const discovery = await discoverPlugins({ projectRoot: root });
    expect(discovery.refused[0]?.refusal).toBe('escapes-package');
    expect(discovery.loaded).toEqual([]);
  });

  it('accepts a default export as well as a named one', async () => {
    const root = await project([
      { name: 'defaulted', manifest: ok, source: `export default { name: 'd', register() {} };` },
    ]);
    expect((await discoverPlugins({ projectRoot: root })).loaded).toHaveLength(1);
  });

  it('loads scoped packages', async () => {
    // The first-party layers are all scoped, so a loader that only handled bare
    // names would work on every fixture and on none of the real packages.
    const root = await project([{ name: '@sdlc-on-fire/demo', manifest: ok, source: WORKING }]);
    expect((await discoverPlugins({ projectRoot: root })).loaded[0]?.package).toBe(
      '@sdlc-on-fire/demo',
    );
  });

  it('loads in sorted order, not in package.json key order', async () => {
    // Registration order is program behaviour. Object key order is whatever the
    // package manager last wrote, so two installs of the same set could produce
    // two different programs.
    const root = await project([
      { name: 'zzz', manifest: ok, source: WORKING },
      { name: 'aaa', manifest: ok, source: WORKING },
      { name: 'mmm', manifest: ok, source: WORKING },
    ]);
    const discovery = await discoverPlugins({ projectRoot: root });
    expect(discovery.loaded.map((entry) => entry.package)).toEqual(['aaa', 'mmm', 'zzz']);
  });

  it('says nothing at all in a directory that is not an npm project', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sdlcof-bare-'));
    roots.push(root);
    const discovery = await discoverPlugins({ projectRoot: root });
    expect(discovery).toEqual({ loaded: [], refused: [], examined: 0 });
  });

  it('does not report a declared dependency that was never installed', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sdlcof-missing-'));
    roots.push(root);
    await fs.writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'h', dependencies: { 'never-installed': '1.0.0' } }),
      'utf8',
    );
    const discovery = await discoverPlugins({ projectRoot: root });
    expect(discovery.refused).toEqual([]);
    expect(discovery.examined).toBe(1);
  });
});

describe('formatPlugins', () => {
  it('always prints refusals, even when something loaded', async () => {
    // The case where silence is worst: the user installed a layer and is
    // entitled to know it is not running.
    const root = await project([
      { name: 'aaa-good', manifest: ok, source: WORKING },
      { name: 'zzz-future', manifest: { ...ok, api: SDLC_PLUGIN_API + 1 }, source: WORKING },
    ]);
    const text = formatPlugins(await discoverPlugins({ projectRoot: root }));
    expect(text).toContain('aaa-good');
    expect(text).toContain('zzz-future');
    expect(text).toContain('api-mismatch');
  });

  it('says how many dependencies were examined when nothing loaded', async () => {
    const root = await project([{ name: 'lodash', manifest: null }]);
    expect(formatPlugins(await discoverPlugins({ projectRoot: root }))).toContain('1 declared');
  });
});

describe('projectRootFromArgv', () => {
  it('honours -C and --cwd, so the right project s layers load', () => {
    // Registration happens before commander parses, so this value is needed
    // earlier than commander can supply it. Falling back to cwd would silently
    // load the wrong project s layers under `sdlc -C ../other status`.
    expect(projectRootFromArgv(['-C', '/tmp/x', 'status'], '/home')).toBe(path.resolve('/tmp/x'));
    expect(projectRootFromArgv(['--cwd', 'sub', 'status'], '/home')).toBe(
      path.resolve('/home/sub'),
    );
    expect(projectRootFromArgv(['--cwd=sub', 'status'], '/home')).toBe(path.resolve('/home/sub'));
  });

  it('falls back to the working directory', () => {
    expect(projectRootFromArgv(['status'], '/home')).toBe('/home');
  });

  it('does not swallow the next flag as a path', () => {
    expect(projectRootFromArgv(['-C', '--json'], '/home')).toBe('/home');
  });
});
