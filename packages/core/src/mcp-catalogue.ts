/**
 * Suggesting MCP servers for a project's stack (P2-MCP-02, ADR-0058).
 *
 * ADR-0058 asks the agent to scan for MCPs relevant to the user's technologies
 * and suggest them "with a plain-language explanation of the capability each
 * provides", **grounded** — real, cited servers, user opts in.
 *
 * "Grounded" is the load-bearing word, and it is why this is a dated catalogue
 * rather than a model call. Asked which MCP server exists for a technology, a
 * language model will produce a plausible repository URL for one that does not
 * exist, phrased exactly like one for a server that does. The suggestion then
 * carries a user through `npx` at a package name somebody else can register.
 * That is not a hypothetical class of mistake; it is the whole reason
 * [ADR-0045] exists one layer up, and here it ends in an install rather than a
 * wrong sentence.
 *
 * So a recommendation is emitted only when it has a resolvable source and the
 * date somebody last checked it — the same rule, and the same self-application,
 * as the scaffold registry in `tech-stack.ts`. **A catalogue that goes stale
 * without saying so is the thing being guarded against, so it says so.**
 *
 * ADR-0024's risk register adds the other half: the registry landscape
 * (mcp.so, smithery.ai, glama.ai) is young and fragmented with no canonical
 * authority, and building against any one registry's API is premature. This
 * therefore depends on none of them. It is a short, hand-checked list, and the
 * honest limitation is that it covers what somebody put in it — which
 * `unmatchedTechnologies` reports rather than hides.
 */

/** How sure the catalogue is that this server suits this technology. */
export const MATCH_STRENGTHS = ['first-party', 'community'] as const;
export type MatchStrength = (typeof MATCH_STRENGTHS)[number];

export interface CatalogueEntry {
  /** The id a consent record would use. */
  readonly id: string;
  /** Package names or tech folder names this serves. */
  readonly forTech: readonly string[];
  /** Plain language, per ADR-0058 — what the agent could do that it cannot now. */
  readonly capability: string;
  /** Where the server lives. Must resolve; never a recollection. */
  readonly source: string;
  readonly strength: MatchStrength;
  /** When somebody last checked `source` was real and current. */
  readonly checkedOn: string;
  /**
   * Whether this server can be run with a read-only grant, and how.
   *
   * Carried because it is the first question `mcp consent` asks: a server with
   * no read-only mode means every useful call needs a human, which is a
   * materially different suggestion and worth knowing before installing.
   */
  readonly readOnlyMode?: string | undefined;
}

/**
 * The catalogue.
 *
 * Deliberately short and hand-checked. Every entry has a source and a date;
 * adding one without both is adding the fabrication this module exists to
 * prevent.
 */
export const MCP_CATALOGUE: readonly CatalogueEntry[] = [
  {
    id: 'supabase',
    forTech: ['supabase', '@supabase/supabase-js'],
    capability:
      'Read the project’s actual database schema, tables and logs, so a spec or a migration plan is written against what is there rather than what the code implies.',
    source: 'https://github.com/supabase-community/supabase-mcp',
    strength: 'first-party',
    checkedOn: '2026-08-14',
    readOnlyMode: '--read-only, plus a database role restricted to SELECT',
  },
  {
    id: 'github',
    forTech: ['github', 'octokit', '@octokit/rest'],
    capability:
      'Read issues, pull requests and CI results directly, so a work item can be checked against the discussion that produced it instead of a pasted summary.',
    source: 'https://github.com/github/github-mcp-server',
    strength: 'first-party',
    checkedOn: '2026-08-14',
    readOnlyMode: '--read-only',
  },
  {
    id: 'postgres',
    forTech: ['pg', 'postgres', 'drizzle-orm'],
    capability:
      'Inspect a live schema — tables, indexes, constraints — so a migration is planned against the real database rather than the model file.',
    source: 'https://github.com/modelcontextprotocol/servers/tree/main/src/postgres',
    strength: 'first-party',
    checkedOn: '2026-08-14',
    readOnlyMode: 'connect with a read-only user',
  },
  {
    id: 'playwright',
    forTech: ['playwright', '@playwright/test'],
    capability:
      'Drive a real browser to reproduce a bug or verify a flow, producing a trace as evidence rather than a description of what probably happens.',
    source: 'https://github.com/microsoft/playwright-mcp',
    strength: 'first-party',
    checkedOn: '2026-08-14',
  },
];

/** How long a catalogue entry is trusted before somebody re-checks it. */
export const CATALOGUE_MAX_AGE_DAYS = 180;

export interface Recommendation {
  readonly id: string;
  readonly forTech: readonly string[];
  readonly capability: string;
  readonly source: string;
  readonly strength: MatchStrength;
  readonly checkedOn: string;
  readonly readOnlyMode?: string | undefined;
  /** True when the entry is old enough that somebody should re-verify it. */
  readonly stale: boolean;
}

export interface RecommendationResult {
  readonly recommendations: readonly Recommendation[];
  /**
   * Technologies the catalogue has nothing for.
   *
   * Reported rather than omitted. A recommender that lists four suggestions and
   * says nothing about the eleven technologies it had no entry for reads as
   * "there is nothing else", when it means "nobody has looked". Those are
   * different, and only one of them is true.
   */
  readonly unmatched: readonly string[];
  /** Ids already consented or declined — never suggested again. */
  readonly settled: readonly string[];
}

const daysSince = (from: string, today: string): number => {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${today}T00:00:00Z`);
  return Number.isNaN(a) || Number.isNaN(b) ? Number.POSITIVE_INFINITY : (b - a) / 86_400_000;
};

/** A technology as the stack detector reports it: a folder name and its packages. */
export interface StackTechnology {
  readonly tech: string;
  readonly packages: readonly string[];
}

/**
 * Suggests servers for the technologies a project actually uses.
 *
 * **Matched on both names, reported by one.** A catalogue entry may be keyed on
 * `@supabase/supabase-js` while the stack detector calls that technology
 * `supabase`, so matching has to see both; but an `unmatched` list carrying
 * every package *and* every folder name reads as twice as much missing coverage
 * as there is, and a report that overstates its own gaps gets skimmed.
 *
 * `settledIds` are servers the user has already consented to or declined.
 * Neither is suggested again — and the decline case is the one that matters:
 * ADR-0058 wants a decline *recorded and revisable*, and a recommender that
 * re-suggests a declined server every run has converted a recorded decision
 * into a prompt the user has to keep answering.
 */
export function recommendMcpServers(
  technologies: readonly StackTechnology[],
  today: string,
  settledIds: readonly string[] = [],
  catalogue: readonly CatalogueEntry[] = MCP_CATALOGUE,
): RecommendationResult {
  const settled = new Set(settledIds);
  const byName = new Map<string, string>();
  for (const technology of technologies) {
    byName.set(technology.tech.toLowerCase(), technology.tech);
    for (const pkg of technology.packages) byName.set(pkg.toLowerCase(), technology.tech);
  }

  const matched = new Set<string>();
  const recommendations: Recommendation[] = [];

  for (const entry of catalogue) {
    const hits = entry.forTech.filter((tech) => byName.has(tech.toLowerCase()));
    if (hits.length === 0) continue;
    // Recorded against the *technology*, so a match on a package name still
    // counts that technology as covered.
    for (const hit of hits) matched.add(byName.get(hit.toLowerCase()) ?? hit);
    if (settled.has(entry.id)) continue;

    recommendations.push({
      ...entry,
      forTech: hits,
      stale: daysSince(entry.checkedOn, today) > CATALOGUE_MAX_AGE_DAYS,
    });
  }

  return {
    recommendations: recommendations.sort((a, b) => a.id.localeCompare(b.id)),
    unmatched: technologies
      .map((technology) => technology.tech)
      .filter((tech) => !matched.has(tech))
      .sort(),
    settled: [...settled].sort(),
  };
}

export function formatRecommendations(result: RecommendationResult): string {
  const lines: string[] = [];

  for (const entry of result.recommendations) {
    lines.push(
      `${entry.id}  (${entry.strength}, for ${entry.forTech.join(', ')})`,
      `  ${entry.capability}`,
      `  ${entry.source}${entry.stale ? '  ⚠ last checked ' + entry.checkedOn + ' — re-verify before installing' : ''}`,
      entry.readOnlyMode === undefined
        ? '  no read-only mode known — every call would need a person to approve it'
        : `  read-only: ${entry.readOnlyMode}`,
      '',
    );
  }

  if (result.recommendations.length === 0) {
    lines.push('Nothing to suggest.', '');
  } else {
    lines.push(
      'Suggestions only. Nothing is installed or enabled until you run',
      '`sdlc mcp consent <id>` — and declining is recorded, not forgotten.',
      '',
    );
  }

  if (result.settled.length > 0) {
    lines.push(`Already decided: ${result.settled.join(', ')} (not suggested again).`);
  }
  if (result.unmatched.length > 0) {
    // Said out loud. "Nothing else exists" and "nobody has looked" are
    // different claims, and only one of them is true.
    lines.push(
      `No catalogue entry for: ${result.unmatched.join(', ')}.`,
      'That means nobody has added one, not that no server exists.',
    );
  }
  return lines.join('\n');
}
