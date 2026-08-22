import { describe, expect, it } from 'vitest';
import {
  buildListing,
  installable,
  tierCounts,
  tierExplanation,
  trustTier,
  type RegistryEntry,
  type RegistryTrust,
} from './skill-registry.js';

const TRUST: RegistryTrust = { trustedKeyIds: ['registry-root', 'partner-key'] };

function entry(over: Partial<RegistryEntry> = {}): RegistryEntry {
  return {
    name: 'skill-a',
    version: '1.0.0',
    publisher: 'someone',
    signedBy: null,
    findings: [],
    ...over,
  };
}

describe('trustTier', () => {
  it('defaults a clean unknown entry to unreviewed, not to a warning', () => {
    expect(trustTier(entry(), TRUST)).toBe('unreviewed');
  });

  it('needs both a trusted signature and a named review to reach verified', () => {
    expect(trustTier(entry({ signedBy: 'registry-root' }), TRUST)).toBe('community');
    expect(trustTier(entry({ reviewedBy: 'maintainer' }), TRUST)).toBe('unreviewed');
    expect(trustTier(entry({ signedBy: 'registry-root', reviewedBy: 'maintainer' }), TRUST)).toBe(
      'verified',
    );
  });

  it('will not call a signature from an untrusted key verified, even with a review', () => {
    const stranger = entry({ signedBy: 'some-key-they-made', reviewedBy: 'themselves' });
    expect(trustTier(stranger, TRUST)).toBe('community');
  });

  it('refuses an entry with a blocking finding however popular or well-signed', () => {
    const bad = entry({
      signedBy: 'registry-root',
      reviewedBy: 'maintainer',
      adoption: 100_000,
      findings: [{ rule: 'remote-execution', severity: 'block', detail: 'curl | sh' }],
    });
    expect(trustTier(bad, TRUST)).toBe('refused');
  });

  it('does not let a non-blocking finding drag a tier down', () => {
    const noisy = entry({
      signedBy: 'registry-root',
      reviewedBy: 'maintainer',
      findings: [{ rule: 'network-access', severity: 'warn', detail: 'fetches a URL' }],
    });
    expect(trustTier(noisy, TRUST)).toBe('verified');
  });

  it('promotes an unsigned entry to community only once adoption clears the threshold', () => {
    expect(trustTier(entry({ adoption: 24 }), TRUST)).toBe('unreviewed');
    expect(trustTier(entry({ adoption: 25 }), TRUST)).toBe('community');
  });

  it('honours an operator threshold instead of the default', () => {
    const strict: RegistryTrust = { trustedKeyIds: [], communityThreshold: 5_000 };
    expect(trustTier(entry({ adoption: 4_999 }), strict)).toBe('unreviewed');
    expect(trustTier(entry({ adoption: 5_000 }), strict)).toBe('community');
  });

  it('treats an empty trusted-key list as trusting nobody, not everybody', () => {
    const empty: RegistryTrust = { trustedKeyIds: [] };
    expect(trustTier(entry({ signedBy: 'registry-root', reviewedBy: 'm' }), empty)).toBe(
      'community',
    );
  });
});

describe('tierExplanation', () => {
  it('says out loud that verified is about provenance, not about the code being good', () => {
    expect(tierExplanation('verified')).toContain('provenance');
    expect(tierExplanation('verified')).toMatch(/not about whether the code is good/);
  });

  it('describes unreviewed as normal rather than as a warning', () => {
    expect(tierExplanation('unreviewed')).toContain('normal state');
  });

  it('gives every tier its own wording', () => {
    const all = (['verified', 'community', 'unreviewed', 'refused'] as const).map(tierExplanation);
    expect(new Set(all).size).toBe(4);
  });
});

describe('installable', () => {
  it('blocks only refused', () => {
    expect(installable('refused')).toBe(false);
    expect(installable('unreviewed')).toBe(true);
    expect(installable('community')).toBe(true);
    expect(installable('verified')).toBe(true);
  });
});

describe('buildListing', () => {
  const entries: readonly RegistryEntry[] = [
    entry({ name: 'zebra', signedBy: 'registry-root', reviewedBy: 'm' }),
    entry({ name: 'apple' }),
    entry({
      name: 'banana',
      findings: [{ rule: 'credential-read', severity: 'block', detail: 'reads ~/.aws' }],
    }),
    entry({ name: 'cherry', adoption: 900 }),
    entry({ name: 'alpha', signedBy: 'partner-key', reviewedBy: 'm' }),
  ];

  it('orders by tier first and by name inside a tier', () => {
    const listing = buildListing(entries, TRUST);
    expect(listing.map((l) => l.name)).toEqual(['alpha', 'zebra', 'cherry', 'apple', 'banana']);
  });

  it('never sorts by adoption inside a tier', () => {
    // `apple` has no adoption, `alpha` is not even in this tier; a popularity
    // sort would put the 900-download entry ahead of a name that precedes it.
    const tie = [entry({ name: 'zzz', adoption: 5_000 }), entry({ name: 'aaa', adoption: 30 })];
    expect(buildListing(tie, TRUST).map((l) => l.name)).toEqual(['aaa', 'zzz']);
  });

  it('breaks a name tie by version rather than leaving it to input order', () => {
    const versions = [
      entry({ name: 'same', version: '2.0.0' }),
      entry({ name: 'same', version: '1.0.0' }),
    ];
    expect(buildListing(versions, TRUST).map((l) => l.version)).toEqual(['1.0.0', '2.0.0']);
  });

  it('attaches the explanation that matches each entry’s own tier', () => {
    for (const listing of buildListing(entries, TRUST)) {
      expect(listing.explanation).toBe(tierExplanation(listing.tier));
    }
  });

  it('keeps the entry fields intact alongside the derived ones', () => {
    const [first] = buildListing([entry({ name: 'kept', publisher: 'pub' })], TRUST);
    expect(first?.publisher).toBe('pub');
    expect(first?.name).toBe('kept');
  });
});

describe('tierCounts', () => {
  it('reports every tier including the refusals a registry would rather hide', () => {
    const listing = buildListing(
      [
        entry({ name: 'a', signedBy: 'registry-root', reviewedBy: 'm' }),
        entry({ name: 'b', signedBy: 'registry-root' }),
        entry({ name: 'c' }),
        entry({ name: 'd', findings: [{ rule: 'x', severity: 'block', detail: 'y' }] }),
        entry({ name: 'e', findings: [{ rule: 'x', severity: 'block', detail: 'y' }] }),
      ],
      TRUST,
    );
    expect(tierCounts(listing)).toEqual({ verified: 1, community: 1, unreviewed: 1, refused: 2 });
  });

  it('reports zeroes rather than omitting empty tiers', () => {
    expect(tierCounts([])).toEqual({ verified: 0, community: 0, unreviewed: 0, refused: 0 });
  });
});
