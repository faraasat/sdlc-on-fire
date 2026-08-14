/**
 * Which technologies a project is actually built on (P2-RES-01, ADR-0045).
 *
 * ADR-0045 says research the technology before writing code against it. That
 * presupposes something knows what the technologies *are*, and the honest
 * answer is that a manifest is the only place a program can look without
 * guessing. So this reads dependencies and reports them — with two rules that
 * matter more than the parsing.
 *
 * **Everything is a technology, including the ones we have never heard of.**
 * The registry below names scaffold commands for a handful of well-known
 * packages. A dependency absent from it is not "fine" — it is a technology with
 * no known official CLI, which is a smaller claim than "no research needed".
 * A detector that only reports what it recognises quietly exempts every
 * dependency nobody thought to list, and those are the ones least likely to
 * have been researched.
 *
 * **The registry is dated, because it is research too.** A hardcoded table of
 * `create-next-app` flags is exactly the stale-training-data artifact ADR-0045
 * exists to prevent, one level up. So each entry carries the date it was
 * checked, and `staleRegistryEntries` reports the ones old enough to re-verify.
 * A freshness checker exempt from its own rule is a rule nobody believes.
 */

/** A technology worth a `docs/.research/<tech>/` folder. */
export interface DetectedTech {
  /** Folder name — lowercase-kebab, per the template. */
  readonly tech: string;
  /**
   * Every manifest entry that maps to this technology.
   *
   * More than one when a vendor ships several packages under one scope. They
   * are listed rather than hidden: the template allows a shared folder for
   * packages always adopted together and asks for a split when they version
   * independently, and that is a judgement only someone looking at the list can
   * make.
   */
  readonly packages: readonly { name: string; version: string; scope: string }[];
  /** Present only when an official scaffolding CLI is known for it. */
  readonly scaffold?: ScaffoldCommand | undefined;
}

export interface ScaffoldCommand {
  /** The exact command ADR-0045 asks to be recorded in `scaffold.md`. */
  readonly command: string;
  /** Where that command is documented. Never a recollection. */
  readonly source: string;
  /** When this entry was last checked against that source. */
  readonly checkedOn: string;
}

/**
 * Packages whose vendor ships an official scaffolding CLI.
 *
 * Deliberately short. This is not an attempt at a catalogue of the ecosystem —
 * it is the handful where hand-authoring boilerplate is a known mistake, and
 * every entry has a source and a date. Adding one without both is adding the
 * thing this module exists to prevent.
 */
export const SCAFFOLD_REGISTRY: Readonly<Record<string, ScaffoldCommand>> = {
  next: {
    command: 'npx create-next-app@latest',
    source: 'https://nextjs.org/docs/app/api-reference/cli/create-next-app',
    checkedOn: '2026-08-14',
  },
  vite: {
    command: 'npm create vite@latest',
    source: 'https://vite.dev/guide/#scaffolding-your-first-vite-project',
    checkedOn: '2026-08-14',
  },
  'drizzle-orm': {
    command: 'npx drizzle-kit generate',
    source: 'https://orm.drizzle.team/docs/kit-overview',
    checkedOn: '2026-08-14',
  },
  '@supabase/supabase-js': {
    command: 'npx supabase init',
    source: 'https://supabase.com/docs/guides/local-development/cli/getting-started',
    checkedOn: '2026-08-14',
  },
  astro: {
    command: 'npm create astro@latest',
    source: 'https://docs.astro.build/en/install-and-setup/',
    checkedOn: '2026-08-14',
  },
  nuxt: {
    command: 'npm create nuxt@latest',
    source: 'https://nuxt.com/docs/getting-started/installation',
    checkedOn: '2026-08-14',
  },
};

/** How long a registry entry is trusted before it should be re-checked. */
export const REGISTRY_MAX_AGE_DAYS = 180;

/**
 * Packages that are not "a technology" for research purposes.
 *
 * Tooling we configure rather than build against, where a research folder would
 * be four files of ceremony about a linter. Kept small and explicit: every name
 * here is a technology someone decided not to research, and that decision
 * should be as visible as the ones to research.
 */
export const NOT_A_TECH = new Set([
  'typescript',
  'eslint',
  'prettier',
  'vitest',
  'tsup',
  'globals',
]);

/**
 * Package-name shapes that are lint or type plumbing rather than a technology.
 *
 * Patterns rather than names because these are open families — a project has
 * however many `eslint-plugin-*` packages it has, and listing each one is a
 * list that goes stale in the boring direction. `@types/*` are declaration
 * files for something already detected under its own name.
 */
export const NOT_A_TECH_PATTERNS = [
  /^@types\//,
  /^eslint-config-/,
  /^eslint-plugin-/,
  /-eslint(-|$)/,
] as const;

export const isTechnology = (pkg: string): boolean =>
  !NOT_A_TECH.has(pkg) && !NOT_A_TECH_PATTERNS.some((pattern) => pattern.test(pkg));

/**
 * The research folder a package belongs in.
 *
 * A **scoped package maps to its scope**: `@supabase/supabase-js` is research
 * about Supabase, `@changesets/cli` about Changesets. The first version of this
 * took the other half of the name and produced folders called `cli` and `js` —
 * names that identify nothing, collide with every other vendor's `cli`, and
 * would have been committed as a research folder about an unnamed technology.
 * Found by running it against this repository's own manifest.
 *
 * The cost is that a vendor shipping independently-versioned libraries under
 * one scope gets one folder. That is the template's own default ("may share one
 * folder if they're always adopted together; split them if they version
 * independently") and the split is a judgement, so `DetectedTech.packages`
 * lists what was merged rather than hiding it.
 */
export function techNameFor(pkg: string): string {
  const base = pkg.startsWith('@') ? (pkg.slice(1).split('/')[0] ?? pkg.slice(1)) : pkg;
  return base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

const DEPENDENCY_SCOPES = ['dependencies', 'devDependencies', 'peerDependencies'] as const;

/**
 * Reads a `package.json` and reports the technologies in it.
 *
 * Sorted by name so a report diffs readably, and de-duplicated by package: a
 * dependency that is also a peer dependency is one technology, not two.
 */
export function detectStack(manifest: unknown): DetectedTech[] {
  if (typeof manifest !== 'object' || manifest === null) return [];
  const record = manifest as Record<string, unknown>;

  const byTech = new Map<string, { name: string; version: string; scope: string }[]>();
  const seen = new Set<string>();

  for (const scope of DEPENDENCY_SCOPES) {
    const group = record[scope];
    if (typeof group !== 'object' || group === null) continue;
    for (const [pkg, version] of Object.entries(group as Record<string, unknown>)) {
      if (!isTechnology(pkg) || seen.has(pkg)) continue;
      seen.add(pkg);
      const tech = techNameFor(pkg);
      if (!isTechnology(tech)) continue;
      const list = byTech.get(tech) ?? [];
      list.push({ name: pkg, version: typeof version === 'string' ? version : '', scope });
      byTech.set(tech, list);
    }
  }

  return [...byTech.entries()]
    .map(([tech, packages]) => {
      const scaffold = packages
        .map((entry) => SCAFFOLD_REGISTRY[entry.name])
        .find((entry) => entry !== undefined);
      return {
        tech,
        packages: packages.sort((a, b) => a.name.localeCompare(b.name)),
        ...(scaffold === undefined ? {} : { scaffold }),
      };
    })
    .sort((a, b) => a.tech.localeCompare(b.tech));
}

/**
 * Registry entries old enough that their command should be re-verified.
 *
 * The self-referential half of ADR-0045: this table is research, it goes stale
 * the same way any other research does, and a checker exempt from its own rule
 * is a rule nobody believes. Reported, never auto-expired — an old entry is
 * still better than none, and silently dropping it would leave a project
 * hand-scaffolding for want of a date.
 */
export function staleRegistryEntries(
  today: string,
  registry: Readonly<Record<string, ScaffoldCommand>> = SCAFFOLD_REGISTRY,
): string[] {
  const now = Date.parse(`${today}T00:00:00Z`);
  if (Number.isNaN(now)) throw new Error(`today is not an ISO date: "${today}"`);

  return Object.entries(registry)
    .filter(([, entry]) => {
      const checked = Date.parse(`${entry.checkedOn}T00:00:00Z`);
      return Number.isNaN(checked) || (now - checked) / 86_400_000 > REGISTRY_MAX_AGE_DAYS;
    })
    .map(([pkg]) => pkg)
    .sort();
}
