/**
 * The plugin manifest: how an installed layer says it is one (P3-PKG-02,
 * `.research/techniques/46`).
 *
 * Until now a layer was reachable only because `cli/index.ts` imported it by
 * name, which means adding a capability required a release of the CLI. Somebody
 * on the bare `sdlc-on-fire` package who installed a future layer got nothing
 * at all — the opposite of what a layered publish is for.
 *
 * **The plugin declares; the host discovers.** The alternative — the host
 * naming its plugins in a config file, as oclif does — was rejected because it
 * makes adopting a layer two steps, and forgetting the second is
 * indistinguishable from the layer being broken.
 *
 * **Declared dependencies only, never a walk of `node_modules`.** This is the
 * whole security argument and it is worth stating where the code is. OpenClaw
 * auto-loaded plugins from a directory *inside the workspace*, so cloning a
 * hostile repository and running the tool executed the attacker's code —
 * CWE-829, rated High (GHSA-99qw-6mr3-36qr). Discovering from the dependency
 * set a project's own `package.json` declares does not have that property:
 * installing a package already grants it code execution, at `postinstall` and
 * again at first import, so discovery moves *when* consented-to code loads and
 * never *whether*. Walking `node_modules` would throw that distinction away —
 * a vendored or checked-in package nobody declared would become loadable, and
 * `clone && run` would be an exploit again.
 *
 * This module is the pure half: what a manifest must look like and whether a
 * given one is admissible. Resolving and importing the module is the CLI's job,
 * because it is I/O and cannot be decided.
 */

import { z } from 'zod';

/**
 * The key a plugin declares itself under, in its own `package.json`.
 *
 * Namespaced to the product rather than something like `plugin`, because this
 * lands in a file shared with every other tool that reads `package.json`.
 */
export const PLUGIN_MANIFEST_KEY = 'sdlc-on-fire';

/**
 * The plugin API this host speaks.
 *
 * An integer, deliberately, and not a semver range: comparing two integers is a
 * disposer, and deciding whether a range "probably covers" a host is a
 * judgement (ADR-0040). It is bumped when the contract a plugin is written
 * against changes shape — not when the product's version changes.
 */
export const SDLC_PLUGIN_API = 1;

/**
 * What a plugin writes in its `package.json`:
 *
 * ```json
 * { "sdlc-on-fire": { "api": 1, "plugin": "./dist/plugin.js" } }
 * ```
 */
export const PluginManifestSchema = z.object({
  /** The API version the plugin was written against. */
  api: z.number().int().positive(),
  /** Module path, relative to the plugin's own package root, exporting the plugin. */
  plugin: z.string().min(1),
  /** Optional display name; the package name is used when absent. */
  title: z.string().min(1).optional(),
});

export type PluginManifest = z.infer<typeof PluginManifestSchema>;

/** Why a declared plugin was not admitted. */
export const PLUGIN_REFUSALS = [
  'not-declared',
  'malformed',
  'api-mismatch',
  'escapes-package',
] as const;
export type PluginRefusal = (typeof PLUGIN_REFUSALS)[number];

/**
 * Whether a plugin's declared API is the one a host speaks.
 *
 * Split out and parameterised on the host version for a testability reason
 * worth recording: inside {@link admitPlugin} the host version is the constant
 * `1`, and no *valid* manifest can declare anything below it — `0` is refused
 * as malformed before any comparison happens. So `!==` and `>` are
 * indistinguishable there, and a mutation swapping them survives every test
 * that can be written against the constant. Passing the host version in makes
 * the asymmetry reachable, which is the difference between a disposer that is
 * covered and one that merely looks covered.
 */
export function apiMatches(pluginApi: number, hostApi: number = SDLC_PLUGIN_API): boolean {
  return pluginApi === hostApi;
}

export type PluginAdmission =
  | { readonly admitted: true; readonly manifest: PluginManifest }
  | { readonly admitted: false; readonly refusal: PluginRefusal; readonly because: string };

/**
 * Whether a package's `package.json` declares an admissible plugin.
 *
 * `not-declared` is the overwhelmingly common answer and is not a problem: most
 * dependencies of a project using this product are not layers of it. It is kept
 * distinct from the other refusals precisely so that "your plugin is broken"
 * never gets reported as "this is an ordinary package".
 */
export function admitPlugin(packageJson: unknown): PluginAdmission {
  const declared =
    typeof packageJson === 'object' && packageJson !== null
      ? (packageJson as Record<string, unknown>)[PLUGIN_MANIFEST_KEY]
      : undefined;

  if (declared === undefined) {
    return { admitted: false, refusal: 'not-declared', because: 'no sdlc-on-fire key' };
  }

  const parsed = PluginManifestSchema.safeParse(declared);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      admitted: false,
      refusal: 'malformed',
      because: issue ? `${issue.path.join('.') || '(root)'}: ${issue.message}` : 'invalid manifest',
    };
  }

  const manifest = parsed.data;

  // Refuse rather than warn. A plugin loaded against an API it was not written
  // against produces evidence about a contract it does not implement, and wrong
  // evidence is worse for this product than an absent layer. Both numbers are
  // named, because "incompatible" without them is unactionable.
  if (!apiMatches(manifest.api)) {
    return {
      admitted: false,
      refusal: 'api-mismatch',
      because: `plugin targets API ${manifest.api}, this host speaks ${SDLC_PLUGIN_API}`,
    };
  }

  // The entry is resolved relative to the plugin's own root, so a path that
  // climbs out of it would let a manifest name a module in an unrelated
  // package — or outside node_modules entirely.
  if (manifest.plugin.startsWith('/') || manifest.plugin.split(/[\\/]/).includes('..')) {
    return {
      admitted: false,
      refusal: 'escapes-package',
      because: `entry ${manifest.plugin} must stay inside the package`,
    };
  }

  return { admitted: true, manifest };
}

/**
 * The declared dependency names of a host `package.json`, sorted.
 *
 * Sorted because discovery order decides command-registration order, and two
 * runs over one tree that load the same plugins in a different sequence are two
 * different programs. Object key order is insertion order, which is whatever
 * the package manager last wrote.
 *
 * `devDependencies` counts: a layer used only by a project's own tooling is
 * still installed and still declared. `peerDependencies` does not — declaring a
 * peer states a requirement on the consumer, not an installation here.
 */
export function declaredDependencies(packageJson: unknown): readonly string[] {
  if (typeof packageJson !== 'object' || packageJson === null) return [];
  const manifest = packageJson as Record<string, unknown>;
  const names = new Set<string>();
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies'] as const) {
    const block = manifest[field];
    if (typeof block !== 'object' || block === null) continue;
    for (const name of Object.keys(block)) names.add(name);
  }
  return [...names].sort();
}
