import { describe, expect, it } from 'vitest';
import { classifyPackage } from '@sdlc-on-fire/core';
import { createOsvIntel } from './osv.js';

/**
 * P2-SEC-01 — the OSV adapter against the real api.osv.dev.
 *
 * This file exists because of a bug the rest of the suite could not have found.
 * The adapter sent `pkg` where OSV requires `package`; the API answered HTTP
 * 400 to every call; the adapter fail-closed to `assumed`, exactly as designed;
 * and 44 green tests reported a working supply-chain checker that had never
 * once seen an advisory. Every one of those tests stubbed `fetch`, so every one
 * of them agreed with the wrong wire format.
 *
 * A stub can only confirm the shape you already believe. Pinning a wire
 * contract needs the other end of the wire.
 *
 * Skipped — not failed — when the network is unreachable, so an offline laptop
 * or an air-gapped CI runner does not turn "could not check" into a red build.
 * The skip is logged rather than silent: a test that quietly stops running is
 * the same failure mode one layer up.
 */

/** A well-formed npm name nobody has published — the negative control. */
const NONEXISTENT = 'sdlc-on-fire-negative-control-do-not-publish';

const reachable = await fetch('https://api.osv.dev/v1/querybatch', {
  method: 'POST',
  body: JSON.stringify({ queries: [{ package: { name: 'lodash', ecosystem: 'npm' } }] }),
  headers: { 'content-type': 'application/json' },
  signal: AbortSignal.timeout(8_000),
})
  .then((response) => response.ok)
  .catch(() => false);

if (!reachable) {
  console.warn('[osv.live] api.osv.dev unreachable — live advisory tests skipped, not passed.');
}

describe.skipIf(!reachable)('createOsvIntel against the live API', () => {
  it('finds the advisories a known-vulnerable version really has', async () => {
    const [signals] = await createOsvIntel({ timeoutMs: 15_000 }).lookup([
      { name: 'lodash', ecosystem: 'npm', version: '4.17.15' },
    ]);

    // lodash 4.17.15 carries long-published, permanently-fixed GHSAs (prototype
    // pollution, ReDoS). Asserting "at least one" rather than an exact list:
    // OSV's contents change as advisories are added, and a test that pins them
    // would fail on someone else's disclosure rather than on our code.
    expect(signals?.advisories.length).toBeGreaterThan(0);
    expect(signals?.advisories.some((id) => id.startsWith('GHSA-'))).toBe(true);
    // The end that matters: a real advisory reaches the classifier as a strike.
    expect(classifyPackage(signals!).verdict).toBe('slop');
  }, 30_000);

  it('returns nothing for a package that does not exist — which is the whole problem', async () => {
    const [signals] = await createOsvIntel({ timeoutMs: 15_000 }).lookup([
      { name: NONEXISTENT, ecosystem: 'npm' },
    ]);

    // The negative control is a name nobody has published, rather than a
    // "clean" real package: this assertion has to stay true tomorrow, and any
    // real package can acquire an advisory overnight. (An earlier draft of
    // this test used lodash 4.17.21 as the clean case. It failed on first run —
    // 4.17.21 carries open advisories today.)
    expect(signals?.advisories).toEqual([]);

    // And the finding that matters for slopsquatting: an advisory database
    // answers "no advisories" for a package it has never heard of, exactly as
    // it does for a package that is genuinely fine. So OSV alone can never
    // clear a hallucinated name — it can only ever fail to condemn it. That is
    // why a clean advisory check still classifies as `assumed`, and why the
    // registry-metadata signals are a separate source rather than a nicety.
    expect(classifyPackage(signals!).verdict).toBe('assumed');
  }, 30_000);

  it('keeps a batch positional across a mixed list', async () => {
    const signals = await createOsvIntel({ timeoutMs: 15_000 }).lookup([
      { name: NONEXISTENT, ecosystem: 'npm' },
      { name: 'lodash', ecosystem: 'npm', version: '4.17.15' },
      { name: NONEXISTENT, ecosystem: 'npm' },
    ]);
    // Mis-ordered results would attribute one package's advisories to another —
    // the failure mode that turns a security report into a wrong accusation.
    // The known-vulnerable entry sits in the middle so a result list that is
    // merely truncated, padded, or reversed cannot pass.
    expect(signals[0]?.advisories).toEqual([]);
    expect(signals[1]?.advisories.length).toBeGreaterThan(0);
    expect(signals[2]?.advisories).toEqual([]);
  }, 30_000);
});
