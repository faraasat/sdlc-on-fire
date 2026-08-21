import { describe, expect, it } from 'vitest';
import {
  admitPlugin,
  apiMatches,
  declaredDependencies,
  PLUGIN_MANIFEST_KEY,
  PluginManifestSchema,
  SDLC_PLUGIN_API,
} from './plugin-manifest.js';

/**
 * P3-PKG-02 — the plugin manifest.
 *
 * The property under test is that admission is decided by comparison, never by
 * inference: a manifest is admissible or it is refused with a reason a person
 * can act on, and the one refusal that means "this is just an ordinary
 * dependency" stays distinguishable from the ones that mean "your plugin is
 * broken".
 */

const good = (over: Record<string, unknown> = {}) => ({
  name: 'x',
  [PLUGIN_MANIFEST_KEY]: { api: SDLC_PLUGIN_API, plugin: './dist/plugin.js', ...over },
});

describe('admitPlugin', () => {
  it('admits a well-formed manifest at the current API', () => {
    const result = admitPlugin(good());
    expect(result.admitted).toBe(true);
    if (result.admitted) expect(result.manifest.plugin).toBe('./dist/plugin.js');
  });

  it('separates an ordinary dependency from a broken plugin', () => {
    // Almost every dependency of a project using this product is not a layer of
    // it. If that answer shared a refusal code with a malformed manifest, the
    // report would either be unreadable noise or would hide real breakage.
    const ordinary = admitPlugin({ name: 'lodash', version: '4.0.0' });
    expect(ordinary.admitted).toBe(false);
    if (!ordinary.admitted) expect(ordinary.refusal).toBe('not-declared');
  });

  it('refuses an API it does not speak, and names both numbers', () => {
    // Refuse rather than warn: a plugin loaded against an API it was not
    // written for reports evidence about a contract it does not implement.
    const result = admitPlugin(good({ api: SDLC_PLUGIN_API + 1 }));
    expect(result.admitted).toBe(false);
    if (!result.admitted) {
      expect(result.refusal).toBe('api-mismatch');
      expect(result.because).toContain(String(SDLC_PLUGIN_API + 1));
      expect(result.because).toContain(String(SDLC_PLUGIN_API));
    }
  });

  it('refuses every valid API that is not this one, in both directions', () => {
    // Written as a sweep rather than as `SDLC_PLUGIN_API - 1`, which was the
    // first version and was untestable: the current API is 1, so "one older" is
    // 0, which the positive-integer check refuses as `malformed` before the
    // comparison is ever reached. The property wanted is that the comparison is
    // `!==` and not `<` — asymmetry would be a silent downgrade path — and a
    // sweep across the valid range states that without depending on the
    // constant's present value.
    for (const api of [1, 2, 3, 4, 5, 99]) {
      const result = admitPlugin(good({ api }));
      if (api === SDLC_PLUGIN_API) {
        expect(result.admitted, `api ${api}`).toBe(true);
        continue;
      }
      expect(result.admitted, `api ${api}`).toBe(false);
      if (!result.admitted) expect(result.refusal, `api ${api}`).toBe('api-mismatch');
    }
  });

  it('refuses an entry path that climbs out of the package', () => {
    // The entry resolves against the plugin's own root. A manifest that escapes
    // it could name a module in an unrelated package, which is the whole reason
    // discovery is restricted to declared dependencies in the first place.
    for (const escape of ['../evil/index.js', './a/../../evil.js', '/etc/passwd']) {
      const result = admitPlugin(good({ plugin: escape }));
      expect(result.admitted, escape).toBe(false);
      if (!result.admitted) expect(result.refusal, escape).toBe('escapes-package');
    }
  });

  it('does not mistake a path merely containing dots for an escape', () => {
    expect(admitPlugin(good({ plugin: './dist/plugin.v2.js' })).admitted).toBe(true);
    expect(admitPlugin(good({ plugin: './..dotted/x.js' })).admitted).toBe(true);
  });

  it('reports which field was malformed', () => {
    const result = admitPlugin(good({ api: 'one' }));
    expect(result.admitted).toBe(false);
    if (!result.admitted) {
      expect(result.refusal).toBe('malformed');
      expect(result.because).toContain('api');
    }
  });

  it('refuses a manifest missing its entry rather than guessing one', () => {
    // Defaulting to `./index.js` would make a typo load something real.
    const result = admitPlugin({ [PLUGIN_MANIFEST_KEY]: { api: SDLC_PLUGIN_API } });
    expect(result.admitted).toBe(false);
    if (!result.admitted) expect(result.refusal).toBe('malformed');
  });

  it('survives input that is not an object at all', () => {
    for (const junk of [null, undefined, 'x', 3, []]) {
      expect(admitPlugin(junk).admitted, String(junk)).toBe(false);
    }
  });

  it('rejects a non-integer or non-positive api', () => {
    for (const api of [0, -1, 1.5]) {
      const result = admitPlugin(good({ api }));
      expect(result.admitted, String(api)).toBe(false);
    }
  });

  it('keeps the manifest key namespaced to the product', () => {
    // A generic key like `plugin` in a file every other tool also reads is a
    // collision waiting to happen.
    expect(PLUGIN_MANIFEST_KEY).toContain('sdlc-on-fire');
    expect(PluginManifestSchema.safeParse({ api: 1, plugin: './p.js' }).success).toBe(true);
  });
});

describe('apiMatches', () => {
  it('is equality, not a floor', () => {
    // Reachable only because the host version is a parameter. A plugin written
    // against an *older* API is refused exactly as firmly as one written
    // against a newer one: it implements a contract this host no longer has,
    // and loading it would produce evidence about that contract.
    expect(apiMatches(5, 5)).toBe(true);
    expect(apiMatches(3, 5)).toBe(false);
    expect(apiMatches(7, 5)).toBe(false);
  });

  it('defaults to the host this build speaks', () => {
    expect(apiMatches(SDLC_PLUGIN_API)).toBe(true);
    expect(apiMatches(SDLC_PLUGIN_API + 1)).toBe(false);
  });
});

describe('declaredDependencies', () => {
  it('returns dependencies and devDependencies, sorted', () => {
    // Sorted because discovery order is registration order: two runs over one
    // tree that load the same plugins in a different sequence are two different
    // programs, and object key order is whatever the package manager wrote.
    const names = declaredDependencies({
      dependencies: { zed: '1', alpha: '1' },
      devDependencies: { middle: '1' },
    });
    expect(names).toEqual(['alpha', 'middle', 'zed']);
  });

  it('does not treat a peer dependency as installed here', () => {
    // Declaring a peer states a requirement on the consumer, not an
    // installation in this project.
    expect(declaredDependencies({ peerDependencies: { core: '1' } })).toEqual([]);
  });

  it('includes optional dependencies', () => {
    expect(declaredDependencies({ optionalDependencies: { opt: '1' } })).toEqual(['opt']);
  });

  it('does not report a package twice when two fields name it', () => {
    const names = declaredDependencies({
      dependencies: { both: '1' },
      devDependencies: { both: '1' },
    });
    expect(names).toEqual(['both']);
  });

  it('is empty for a manifest with no dependencies, and for junk', () => {
    expect(declaredDependencies({ name: 'x' })).toEqual([]);
    for (const junk of [null, undefined, 'x', 3]) {
      expect(declaredDependencies(junk), String(junk)).toEqual([]);
    }
  });
});
