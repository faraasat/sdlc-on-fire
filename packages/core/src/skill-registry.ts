/**
 * The curated registry and its trust tiers (P5-ECO-05).
 *
 * Three tiers — `verified`, `community`, `unreviewed` — and the whole design
 * problem is that a tier is a *label a user reads*, so the way it is computed
 * has to survive being wrong in public.
 *
 * **A tier is derived, never assigned.** Nobody sets `verified`; it falls out of
 * facts that can be re-checked from the entry itself — a signature that
 * verifies against a key the registry trusts, a scan with no blocking finding,
 * a named human review. An assignable tier is a tier that gets assigned, and
 * the first time somebody's marketing copy says "verified" the label stops
 * meaning anything.
 *
 * **`unreviewed` is the default and is not a failure state.** Most useful
 * things anybody publishes will sit there. A registry that treated it as a
 * warning would train people to ignore the one tier that is doing real work,
 * which is the tier that says *this was checked and it was bad* — and that is
 * why refusal is separate from `unreviewed` rather than being its worst case.
 *
 * **Verified means somebody vouched, not that the code is good.** Carried
 * forward from `skill-signing.ts` deliberately: the strongest tier here is a
 * provenance claim, and `tierExplanation` exists so a surface can say so in the
 * same breath as showing the badge.
 */

import type { ScanFinding } from './skill-signing.js';

export const TRUST_TIERS = ['verified', 'community', 'unreviewed', 'refused'] as const;
export type TrustTier = (typeof TRUST_TIERS)[number];

export interface RegistryEntry {
  readonly name: string;
  readonly version: string;
  readonly publisher: string;
  /** Who signed, from `verifySignature`. Null when nothing verified. */
  readonly signedBy: string | null;
  readonly findings: readonly ScanFinding[];
  /** A named human who reviewed it, when one did. */
  readonly reviewedBy?: string | undefined;
  /** Downloads, stars — anything a community signal is made of. */
  readonly adoption?: number | undefined;
}

/** Keys the registry itself vouches for. The trust root, held by the operator. */
export interface RegistryTrust {
  readonly trustedKeyIds: readonly string[];
  /** Adoption at which an unsigned entry may be called `community`. */
  readonly communityThreshold?: number | undefined;
}

const DEFAULT_COMMUNITY_THRESHOLD = 25;

/**
 * Derive the tier.
 *
 * Order matters and is the policy: refusal beats everything, then signature,
 * then adoption. Checking adoption before scan findings would let a popular
 * malicious skill outrank a clean unknown one — which is exactly the failure a
 * trust tier is supposed to prevent, arrived at by sorting the checks
 * conveniently.
 */
export function trustTier(entry: RegistryEntry, trust: RegistryTrust): TrustTier {
  const blocking = entry.findings.filter((finding) => finding.severity === 'block');
  if (blocking.length > 0) return 'refused';

  const trusted = entry.signedBy !== null && trust.trustedKeyIds.includes(entry.signedBy);
  if (trusted && entry.reviewedBy !== undefined) return 'verified';

  // A signature from an untrusted key is not nothing — it is provenance without
  // endorsement — but it is not `verified` either, and collapsing the two is
  // how a registry ends up vouching for whoever generated a keypair.
  if (trusted || entry.signedBy !== null) return 'community';

  const threshold = trust.communityThreshold ?? DEFAULT_COMMUNITY_THRESHOLD;
  if ((entry.adoption ?? 0) >= threshold) return 'community';

  return 'unreviewed';
}

/** What a surface must say next to the badge, so the badge cannot overclaim. */
export function tierExplanation(tier: TrustTier): string {
  switch (tier) {
    case 'verified':
      return 'signed by a key this registry trusts, scanned clean, and reviewed by a named person — a statement about provenance, not about whether the code is good';
    case 'community':
      return 'signed or widely used, but not reviewed by this registry — nobody here has read it';
    case 'unreviewed':
      return 'nobody has checked this. That is the normal state for something new, not a warning about it';
    case 'refused':
      return 'the automated scan found something blocking; this is not offered for installation';
  }
}

/** Whether a tier may be installed at all. */
export function installable(tier: TrustTier): boolean {
  return tier !== 'refused';
}

export interface RegistryListing extends RegistryEntry {
  readonly tier: TrustTier;
  readonly explanation: string;
}

/**
 * Build the listing.
 *
 * Sorted by tier and then by name — never by adoption within a tier, because a
 * popularity sort inside a trust tier is a popularity sort with a trust badge
 * on it, and the badge is what people read.
 */
export function buildListing(
  entries: readonly RegistryEntry[],
  trust: RegistryTrust,
): readonly RegistryListing[] {
  const rank: Record<TrustTier, number> = { verified: 0, community: 1, unreviewed: 2, refused: 3 };
  return entries
    .map((entry) => {
      const tier = trustTier(entry, trust);
      return { ...entry, tier, explanation: tierExplanation(tier) };
    })
    .sort(
      (a, b) =>
        rank[a.tier] - rank[b.tier] ||
        a.name.localeCompare(b.name) ||
        a.version.localeCompare(b.version),
    );
}

/**
 * The counts a registry should publish about itself.
 *
 * Including `refused`, which a registry has every incentive to omit. A catalog
 * that hides what it rejected looks cleaner than it is, and the number is the
 * only public evidence that the scan is running at all.
 */
export function tierCounts(listings: readonly RegistryListing[]): Record<TrustTier, number> {
  const counts: Record<TrustTier, number> = {
    verified: 0,
    community: 0,
    unreviewed: 0,
    refused: 0,
  };
  for (const listing of listings) counts[listing.tier] += 1;
  return counts;
}
