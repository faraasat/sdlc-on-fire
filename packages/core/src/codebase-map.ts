/**
 * Codebase mapping (P4-BROWN-02).
 *
 * Given the shape of an existing repository, propose the domains its
 * specification would be organised around. This is the on-ramp for a brownfield
 * project: the alternative is a blank `specs/` directory and an instruction to
 * "write down what your system does", which is where adoption stops.
 *
 * **An inferred spec is a guess, and the product must never let it pass as an
 * authored one.** That is the single most important property here, and it is
 * structural rather than a matter of tone. A generated tree of forty
 * confident-looking specs is worse than no tree: it looks like the work was
 * done, nobody re-reads it, and every gate downstream is checking against a
 * description nobody ever agreed to. So every inferred domain is emitted
 * carrying `inferred: true`, the validator treats that as unconfirmed, and a
 * human removing the marker is the act that turns a guess into a specification.
 *
 * The mapping itself is deliberately dumb — directory structure, package
 * manifests, test locations. No model reads the code. A confident-sounding
 * summary of what a module "does" is exactly the artifact that would get
 * believed without being checked, and ADR-0040 puts the deterministic answer
 * first: a directory listing is a fact, and "this appears to be the billing
 * domain" is a proposal a person confirms.
 */

/** One file the mapper was told about. Paths are posix, repo-relative. */
export interface MappedFile {
  readonly path: string;
  /** Bytes, when known. Used only to rank domains by weight. */
  readonly size?: number | undefined;
}

/**
 * How much the mapper believes its own proposal.
 *
 * `likely` is a directory that looks like product surface. `unlikely` is one
 * whose *name* is a conventional grab-bag — `utils`, `common`, `shared` — which
 * usually means a pile of helpers with no single obligation to specify. The
 * distinction exists because these cannot be told apart by structure: `utils/`
 * and `helper/` are the same shape on disk, and on the hono pilot one was a
 * grab bag and the other was real product surface.
 *
 * So the mapper reports both and ranks them, rather than guessing. An
 * `unlikely` domain is still shown — silently dropping it would hide a real
 * domain that happens to be badly named — but `--write` skips it by default,
 * because the cost of a wrong stub is a file somebody has to read and delete.
 */
export type DomainConfidence = 'likely' | 'unlikely';

export interface InferredDomain {
  /** Directory-derived, lowercase, filename-safe. */
  readonly slug: string;
  /** The directory this was inferred from. */
  readonly from: string;
  readonly fileCount: number;
  /** Files that look like tests for this domain — the strongest evidence it is one. */
  readonly testCount: number;
  /** Why the mapper proposed it, in one line a person can disagree with. */
  readonly because: string;
  readonly confidence: DomainConfidence;
  /** Always true here. The field exists so the *absence* of it means "a human wrote this". */
  readonly inferred: true;
}

export interface CodebaseMap {
  readonly domains: readonly InferredDomain[];
  readonly filesScanned: number;
  /** Directories deliberately not mapped, with the reason. */
  readonly skipped: readonly { readonly path: string; readonly because: string }[];
}

/**
 * Directories that are *about* the product without being it.
 *
 * Benchmarks, examples and runtime harnesses contain real source files in real
 * directories, so nothing structural separates them from a feature — they are
 * excluded by name because that is the only signal there is. Found on the hono
 * pilot, where `benchmarks`, `perf-measures` and `runtime-tests` were proposed
 * as things to write a specification for; a reader given twelve domains of
 * which three are noise trusts the other nine less.
 *
 * Excluded rather than down-ranked: a benchmark directory is not a
 * badly-named domain, it is not a domain.
 */
const NOT_PRODUCT = new Set([
  'benchmarks',
  'benchmark',
  'bench',
  'perf',
  'perf-measures',
  'performance',
  'examples',
  'example',
  'samples',
  'demo',
  'demos',
  'runtime-tests',
  'e2e',
  'fixtures',
  'scripts',
  'tooling',
  'codemods',
]);

/**
 * Names that conventionally mean "everything that did not fit elsewhere".
 *
 * Proposed, but marked `unlikely`. `helper/` on hono is genuine product surface
 * and `utils/` is a grab bag, and they are indistinguishable by structure — so
 * the mapper says which one it doubts instead of pretending to know.
 */
const GRAB_BAG = new Set([
  'utils',
  'util',
  'helpers',
  'common',
  'shared',
  'misc',
  'lib',
  'types',
  'constants',
]);

/** Directories that describe the toolchain rather than the product. */
const IGNORED = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.next',
  '.turbo',
  'vendor',
  'target',
  '__pycache__',
  '.venv',
]);

const TEST_HINT = /(^|\/)(?:tests?|__tests__|spec)\//i;
const TEST_FILE = /\.(?:test|spec)\.[a-z]+$/i;

/** Source extensions worth counting. Config and lockfiles say nothing about domains. */
const SOURCE = /\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|rb|java|kt|cs|php|swift|scala)$/i;

export function isIgnored(pathname: string): boolean {
  return pathname.split('/').some((segment) => IGNORED.has(segment));
}

export function isTest(pathname: string): boolean {
  return TEST_HINT.test(pathname) || TEST_FILE.test(pathname);
}

/**
 * The directory a file's domain is inferred from.
 *
 * The *second* path segment under a recognised source root, not the first.
 * `src/billing/invoice.ts` is about billing; `src` is about nothing, and a
 * mapper that proposed a `src` domain would produce one giant bucket and call
 * it a specification.
 */
export function domainOf(pathname: string): string | null {
  const parts = pathname.split('/').filter(Boolean);
  if (parts.length < 2) return null;

  const roots = new Set(['src', 'lib', 'app', 'packages', 'internal', 'cmd', 'pkg']);
  let index = 0;
  // Walk past nested source roots: `packages/core/src/billing/x.ts` is billing.
  while (index < parts.length - 1 && roots.has(parts[index] ?? '')) index += 1;
  // A monorepo's package name is itself a reasonable domain, so if the segment
  // after a root is followed by another root, prefer the deeper one.
  if (index + 1 < parts.length - 1 && roots.has(parts[index + 1] ?? '')) index += 2;

  const candidate = parts[index];
  if (candidate === undefined || index === parts.length - 1) return null;
  return candidate;
}

export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug === '' ? 'untitled' : slug;
}

export interface MapOptions {
  /**
   * How many source files a directory needs before it is proposed as a domain.
   *
   * Two, not one. A single file is a utility, and proposing a domain per helper
   * produces a specification tree with more entries than the codebase has
   * ideas — which is the failure mode that makes a generated tree unreadable
   * and therefore unread.
   */
  readonly minFiles?: number;
  readonly maxDomains?: number;
}

/**
 * Propose domains from a file listing.
 *
 * Sorted by evidence — files with tests first, then by size — because the
 * output is a list somebody reads top-down and stops partway, so the ones most
 * likely to be real domains have to be at the top.
 */
export function mapCodebase(files: readonly MappedFile[], options: MapOptions = {}): CodebaseMap {
  const minFiles = options.minFiles ?? 2;
  const maxDomains = options.maxDomains ?? 40;

  const buckets = new Map<string, { from: string; files: number; tests: number }>();
  const skipped: { path: string; because: string }[] = [];
  const seenIgnored = new Set<string>();
  const seenNotProduct = new Set<string>();

  for (const file of files) {
    if (isIgnored(file.path)) {
      const segment = file.path.split('/').find((part) => IGNORED.has(part)) ?? '';
      if (!seenIgnored.has(segment)) {
        seenIgnored.add(segment);
        skipped.push({ path: segment, because: 'describes the toolchain, not the product' });
      }
      continue;
    }
    if (!SOURCE.test(file.path)) continue;

    const domain = domainOf(file.path);
    if (domain === null) continue;

    const key = slugify(domain);
    if (NOT_PRODUCT.has(key)) {
      if (!seenNotProduct.has(key)) {
        seenNotProduct.add(key);
        skipped.push({ path: key, because: 'about the product rather than part of it' });
      }
      continue;
    }
    const bucket = buckets.get(key) ?? { from: domain, files: 0, tests: 0 };
    if (isTest(file.path)) bucket.tests += 1;
    else bucket.files += 1;
    buckets.set(key, bucket);
  }

  const domains = [...buckets.entries()]
    .filter(([, bucket]) => bucket.files >= minFiles)
    .map(([slug, bucket]) => ({
      slug,
      from: bucket.from,
      fileCount: bucket.files,
      testCount: bucket.tests,
      confidence: GRAB_BAG.has(slug) ? ('unlikely' as const) : ('likely' as const),
      because: GRAB_BAG.has(slug)
        ? `${String(bucket.files)} source file(s) under ${bucket.from}/, but "${slug}" usually names a pile of helpers rather than one obligation`
        : bucket.tests > 0
          ? `${String(bucket.files)} source file(s) and ${String(bucket.tests)} test(s) under ${bucket.from}/`
          : `${String(bucket.files)} source file(s) under ${bucket.from}/, no tests found`,
      inferred: true as const,
    }))
    .sort(
      (a, b) =>
        // Confidence first: a reader who stops halfway down the list should
        // have seen every domain the mapper actually believes in.
        Number(a.confidence === 'unlikely') - Number(b.confidence === 'unlikely') ||
        Number(b.testCount > 0) - Number(a.testCount > 0) ||
        b.fileCount - a.fileCount ||
        a.slug.localeCompare(b.slug),
    );

  if (domains.length > maxDomains) {
    skipped.push({
      path: `${String(domains.length - maxDomains)} further domain(s)`,
      because: `capped at ${String(maxDomains)} — a tree nobody can read is a tree nobody reads`,
    });
  }

  return {
    domains: domains.slice(0, maxDomains),
    filesScanned: files.length,
    skipped,
  };
}

/**
 * The stub written for an inferred domain.
 *
 * It deliberately contains **no requirement**. Writing a plausible
 * `The system MUST …` here would be the product inventing a specification and
 * signing it — and every gate downstream would then check against a sentence
 * nobody agreed to. The stub records what was observed and asks; the human
 * writes the obligation and deletes the marker.
 */
export function inferredSpecStub(domain: InferredDomain): string {
  return [
    `---`,
    `inferred: true`,
    `inferred_from: ${domain.from}`,
    `---`,
    ``,
    `# ${domain.from}`,
    ``,
    `> **Inferred, not specified.** This file was proposed by \`sdlc map\` from the`,
    `> repository's structure — ${domain.because}. Nothing here has been agreed by`,
    `> anyone. Write the requirements, then delete the \`inferred: true\` marker;`,
    `> until you do, \`sdlc spec check\` will keep reporting this domain as`,
    `> unconfirmed and no gate will treat it as a specification.`,
    ``,
    `### Requirement: (unwritten)`,
    ``,
    `<!-- What must this domain do? State it with an RFC-2119 keyword — MUST,`,
    `     SHOULD, MAY — so it can be checked and disagreed with. -->`,
    ``,
  ].join('\n');
}
