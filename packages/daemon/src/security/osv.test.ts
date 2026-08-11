import { describe, expect, it, vi } from 'vitest';
import { classifyPackage } from '@sdlc-on-fire/core';
import { createOsvIntel, osvEcosystem, type OsvFetch } from './osv.js';

/**
 * P2-SEC-01 — the OSV adapter.
 *
 * Every test here is about the *failure* paths, because they are what decide
 * whether the gate is honest. An advisory lookup that returns "no advisories"
 * when it never reached the network would turn "we did not look" into "it was
 * fine", and the gate would wave a package through on the strength of an
 * outage.
 */

const okResponse = (body: unknown): ReturnType<OsvFetch> =>
  Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });

describe('osvEcosystem', () => {
  it('maps our names onto OSV’s exact spellings', () => {
    expect(osvEcosystem('npm')).toBe('npm');
    expect(osvEcosystem('pypi')).toBe('PyPI');
    expect(osvEcosystem('cargo')).toBe('crates.io');
  });

  it('returns undefined for something it does not know', () => {
    // An unrecognised ecosystem queried anyway returns no vulns, which looks
    // exactly like a clean package.
    expect(osvEcosystem('hex')).toBeUndefined();
  });
});

describe('createOsvIntel', () => {
  it('reads advisories out of a batch response, in order', async () => {
    const intel = createOsvIntel({
      fetchImpl: () => okResponse({ results: [{ vulns: [{ id: 'GHSA-aaa' }] }, { vulns: [] }] }),
    });

    const signals = await intel.lookup([
      { name: 'bad', ecosystem: 'npm', version: '1.0.0' },
      { name: 'good', ecosystem: 'npm', version: '2.0.0' },
    ]);
    // Positional: results line up with queries, and mismatched order would
    // attribute one package's advisory to another.
    expect(signals[0]?.advisories).toEqual(['GHSA-aaa']);
    expect(signals[1]?.advisories).toEqual([]);
  });

  it('sends one batch request rather than one per package', async () => {
    const fetchImpl = vi.fn<OsvFetch>(() => okResponse({ results: [{}, {}, {}] }));
    const intel = createOsvIntel({ fetchImpl });
    await intel.lookup([
      { name: 'a', ecosystem: 'npm' },
      { name: 'b', ecosystem: 'npm' },
      { name: 'c', ecosystem: 'npm' },
    ]);
    // Keeps the gate's latency flat as a dependency list grows.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('spells the query key `package`, as the API requires', async () => {
    const fetchImpl = vi.fn<OsvFetch>(() => okResponse({ results: [{ vulns: [] }] }));
    await createOsvIntel({ fetchImpl }).lookup([
      { name: 'lodash', ecosystem: 'npm', version: '4.17.15' },
    ]);

    const body = JSON.parse(fetchImpl.mock.calls[0]![1].body) as {
      queries: { package?: { name: string; ecosystem: string }; version?: string }[];
    };
    // This is the assertion the first build was missing. OSV rejects any other
    // spelling with a generic HTTP 400, which this adapter — correctly —
    // reports as `assumed`. So the bug did not surface as a failure: it
    // surfaced as a checker that never found a single advisory, in a shape
    // indistinguishable from being offline.
    expect(body.queries[0]?.package).toEqual({ name: 'lodash', ecosystem: 'npm' });
    expect(body.queries[0]?.version).toBe('4.17.15');
  });

  it('says why it came back empty-handed', async () => {
    const reasons: string[] = [];
    const intel = createOsvIntel({
      onDegraded: (reason) => reasons.push(reason),
      fetchImpl: () => Promise.resolve({ ok: false, status: 400, json: () => Promise.resolve({}) }),
    });
    await intel.lookup([{ name: 'anything', ecosystem: 'npm' }]);
    // "Everything is unverified" has two very different causes — no network, or
    // a checker that is broken. Left undistinguished, the second hides forever
    // behind the first.
    expect(reasons).toEqual(['osv.dev answered HTTP 400']);
  });

  it('does not call the network for an empty list', async () => {
    const fetchImpl = vi.fn<OsvFetch>(() => okResponse({ results: [] }));
    expect(await createOsvIntel({ fetchImpl }).lookup([])).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reports unknown — never clean — when the network fails', async () => {
    const intel = createOsvIntel({ fetchImpl: () => Promise.reject(new Error('offline')) });
    const [signals] = await intel.lookup([{ name: 'anything', ecosystem: 'npm' }]);

    expect(signals?.advisories).toEqual([]);
    // The load-bearing assertion: with no metadata either, the classifier reads
    // this as `assumed`, so the gate still asks a human. If the adapter had
    // filled in a reassuring default, an outage would wave packages through.
    expect(classifyPackage(signals!).verdict).toBe('assumed');
  });

  it('treats a non-2xx response the same way', async () => {
    const intel = createOsvIntel({
      fetchImpl: () => Promise.resolve({ ok: false, status: 429, json: () => Promise.resolve({}) }),
    });
    const [signals] = await intel.lookup([{ name: 'anything', ecosystem: 'npm' }]);
    expect(classifyPackage(signals!).verdict).toBe('assumed');
  });

  it('gives up rather than hanging the gate', async () => {
    const intel = createOsvIntel({
      timeoutMs: 20,
      fetchImpl: () => new Promise(() => undefined),
    });
    const [signals] = await intel.lookup([{ name: 'slow', ecosystem: 'npm' }]);
    // A security check that blocks a build indefinitely is a check someone
    // disables by the end of the week.
    expect(classifyPackage(signals!).verdict).toBe('assumed');
  }, 10_000);

  it('leaves registry metadata undefined rather than guessing it', async () => {
    const intel = createOsvIntel({ fetchImpl: () => okResponse({ results: [{ vulns: [] }] }) });
    const [signals] = await intel.lookup([{ name: 'clean', ecosystem: 'npm' }]);
    // OSV carries advisories, not publish dates or download counts. Inventing
    // them would manufacture confidence the source never supplied.
    expect(signals?.ageDays).toBeUndefined();
    expect(signals?.monthlyDownloads).toBeUndefined();
    expect(classifyPackage(signals!).verdict).toBe('assumed');
  });
});
