/**
 * Source tiering for tech research (P3-RES-02, ADR-0073 §6).
 *
 * [ADR-0045](../../../docs/.plan/decisions/ADR-0045-dependency-research-discipline.md)
 * already required that a tech-research doc **cite** something. What it did not
 * say is that citations are not equal, and the failure that permits is specific
 * rather than theoretical: a figure taken from a page published by an
 * organisation whose business is selling the conclusion it reports, repeated
 * until it reads as settled. [ADR-0073](../../../docs/.plan/decisions/ADR-0073-research-currency-and-source-tiering.md)
 * was written after exactly that happened in this project's own corpus.
 *
 * Three tiers, and the boundary that matters is between B and C:
 *
 * - **A — primary.** A paper with a stated method, the vendor's own docs or
 *   spec for a claim about that vendor, a standards body's text, or the source
 *   itself. Citable as evidence.
 * - **B — substantiated secondary.** Maintainer engineering blogs, practitioner
 *   write-ups, benchmarks that publish their method. Citable, hedged, and
 *   superseded by an A source when one exists.
 * - **C — unsubstantiated secondary.** Marketing, SEO content, listicles,
 *   anything reporting a number without a method. **A lead, never a figure.**
 *
 * The tier is inferred from the URL, and inference is exactly as reliable as it
 * sounds — so the rule is built to fail toward caution. An unrecognised host is
 * **C**, not B: treating "I have never heard of this" as "probably fine" is the
 * substitution the whole tier exists to prevent, and an author who knows better
 * can say so explicitly.
 */

export const SOURCE_TIERS = ['A', 'B', 'C'] as const;
export type SourceTier = (typeof SOURCE_TIERS)[number];

/**
 * Hosts whose content is primary for the claims research actually makes about
 * them: papers and standards, plus the registries and vendor docs a dependency
 * claim resolves against.
 */
const TIER_A_HOSTS = [
  'arxiv.org',
  'doi.org',
  'dl.acm.org',
  'ieeexplore.ieee.org',
  'link.springer.com',
  'openreview.net',
  'usenix.org',
  'rfc-editor.org',
  'ietf.org',
  'datatracker.ietf.org',
  'w3.org',
  'whatwg.org',
  'iso.org',
  'nist.gov',
  'ecma-international.org',
  'npmjs.com',
  'pypi.org',
  'crates.io',
  'pkg.go.dev',
] as const;

/**
 * Hosts that publish real engineering writing but are not the primary record.
 * A maintainer's blog explaining their own library is close to A and stays B:
 * the code and the docs are the record, and the blog is the account of them.
 */
const TIER_B_HOSTS = [
  'github.blog',
  'engineering.fb.com',
  'netflixtechblog.com',
  'stripe.com',
  'martinfowler.com',
  'infoq.com',
  'thoughtworks.com',
  'dora.dev',
  'web.dev',
  'developer.mozilla.org',
] as const;

/**
 * Markers of content written to rank rather than to inform.
 *
 * Matched on the path, not the host, because the same domain routinely carries
 * both a changelog and a listicle.
 */
const TIER_C_MARKERS = [
  'best-',
  'top-10',
  'top-5',
  'ultimate-guide',
  'complete-guide',
  'vs-',
  'alternatives',
  'why-you-should',
  '-in-2024',
  '-in-2025',
  '-in-2026',
] as const;

/** A `docs.<vendor>` or `<vendor>.dev/docs` URL is that vendor's own record. */
function looksOfficial(host: string, pathname: string): boolean {
  return (
    host.startsWith('docs.') ||
    host.startsWith('developer.') ||
    host.startsWith('developers.') ||
    pathname.startsWith('/docs') ||
    pathname.startsWith('/reference') ||
    pathname.startsWith('/spec')
  );
}

/**
 * Whether a host is the project's own site.
 *
 * This is the rule the hostname allowlist cannot express and the one that
 * matters most in practice: `zod.dev` for zod, `nextjs.org` for next, are the
 * primary record for claims about themselves, and no fixed list of hosts will
 * ever contain the library somebody adds tomorrow. Derived from the technology
 * the research is *about*, which the caller already knows.
 *
 * Scoped names are reduced to their meaningful part — `@electric-sql/pglite`
 * is documented at `electric-sql.com`, not at `@electric-sql`.
 */
function isOwnSite(host: string, tech: string | undefined): boolean {
  if (tech === undefined || tech === '') return false;
  const name = tech
    .replace(/^@/, '')
    .split('/')
    .join('-')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  if (name.length < 3) return false;
  const registrable = host.toLowerCase().replace(/[^a-z0-9]/g, '');
  return registrable.includes(name);
}

export interface TieredSource {
  readonly url: string;
  readonly tier: SourceTier;
  readonly why: string;
  /** True when the URL could not be parsed at all. */
  readonly malformed: boolean;
}

/**
 * Classifies one cited source.
 *
 * An explicit `[A]`/`[B]`/`[C]` prefix in the citation wins over inference —
 * the author knows things a hostname does not, and a rule that cannot be
 * overridden by a person who is right is a rule people route around.
 */
export function sourceTierOf(citation: string, tech?: string): TieredSource {
  const declared = /^\[([ABC])\]\s*/i.exec(citation.trim());
  const url = citation.trim().replace(/^\[[ABC]\]\s*/i, '');

  if (declared !== undefined && declared !== null) {
    const tier = declared[1]?.toUpperCase() as SourceTier;
    return { url, tier, why: 'declared by the author', malformed: false };
  }

  let host: string;
  let pathname: string;
  try {
    const parsed = new URL(url);
    host = parsed.hostname.replace(/^www\./, '');
    pathname = parsed.pathname;
  } catch {
    // Not a URL. Could be a paywalled paper cited by title, which ADR-0073
    // explicitly allows — but it cannot be checked, so it is not counted as
    // substantiation either.
    return {
      url,
      tier: 'C',
      why: 'not a resolvable URL — cite it as recalled-not-fetched and take no figure from it',
      malformed: true,
    };
  }

  const lower = `${host}${pathname}`.toLowerCase();
  if (TIER_C_MARKERS.some((marker) => lower.includes(marker))) {
    return { url, tier: 'C', why: 'the path reads as content written to rank', malformed: false };
  }
  if (TIER_A_HOSTS.some((known) => host === known || host.endsWith(`.${known}`))) {
    return { url, tier: 'A', why: `${host} is a primary record`, malformed: false };
  }
  if (isOwnSite(host, tech)) {
    return {
      url,
      tier: 'A',
      why: `${host} is ${tech ?? 'the project'}'s own site`,
      malformed: false,
    };
  }
  if (looksOfficial(host, pathname)) {
    return { url, tier: 'A', why: 'the vendor’s own documentation', malformed: false };
  }
  if (TIER_B_HOSTS.some((known) => host === known || host.endsWith(`.${known}`))) {
    return { url, tier: 'B', why: `${host} publishes engineering writing`, malformed: false };
  }

  // The cautious default, and the important one. "I have never heard of this
  // host" is not evidence that it is reputable.
  return {
    url,
    tier: 'C',
    why: 'unrecognised host — say `[B]` explicitly if you know it publishes its method',
    malformed: false,
  };
}

export interface SourceQuality {
  readonly sources: readonly TieredSource[];
  readonly counts: Readonly<Record<SourceTier, number>>;
  /** Problems that should stop the research being relied on. */
  readonly findings: readonly string[];
  /** False when the doc rests entirely on tier C. */
  readonly substantiated: boolean;
}

/**
 * Judges a document's citations as a set.
 *
 * The rule is deliberately about the *set*, not each citation: one marketing
 * page beside three papers is normal and fine. A doc whose load-bearing figures
 * rest **entirely** on tier C is the failure — and that is a property only the
 * whole list has.
 */
export function assessSources(citations: readonly string[], tech?: string): SourceQuality {
  const sources = citations.map((citation) => sourceTierOf(citation, tech));
  const counts = { A: 0, B: 0, C: 0 } as Record<SourceTier, number>;
  for (const source of sources) counts[source.tier] += 1;

  const findings: string[] = [];
  const substantiated = counts.A + counts.B > 0;

  if (citations.length === 0) {
    findings.push('no sources at all — "I recall it works this way" is not one');
  } else if (!substantiated) {
    findings.push(
      `all ${String(counts.C)} source(s) are tier C — usable as a lead, never as a figure. ` +
        'Find the primary record, or mark the claims unverified (ADR-0073)',
    );
  }

  for (const source of sources.filter((entry) => entry.malformed)) {
    findings.push(`"${source.url}" is not a resolvable URL — ${source.why}`);
  }

  return { sources, counts, findings, substantiated };
}

export function formatSourceQuality(quality: SourceQuality): string {
  const lines = [
    `sources: ${String(quality.counts.A)} primary, ${String(quality.counts.B)} secondary, ${String(quality.counts.C)} unsubstantiated`,
  ];
  for (const source of quality.sources) {
    lines.push(`  [${source.tier}] ${source.url} — ${source.why}`);
  }
  for (const finding of quality.findings) lines.push(`  ✗ ${finding}`);
  return lines.join('\n');
}
