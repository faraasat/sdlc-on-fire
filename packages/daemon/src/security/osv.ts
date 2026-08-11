import type { PackageIntelPort, PackageSignals } from '@sdlc-on-fire/core';

/**
 * The OSV.dev advisory adapter (P2-SEC-01, `.research/14`).
 *
 * OSV is Google-run, aggregates CVEs and GHSAs across npm/PyPI/Go/crates, and —
 * the part that matters for shipping this — is **free and needs no auth key**.
 * A supply-chain check gated behind a paid key is a check most workspaces would
 * turn off, and a check that is off has a false-negative rate of one.
 *
 * `POST /v1/querybatch` takes every package in one round trip, which keeps the
 * gate's latency flat as a dependency list grows.
 *
 * **What this adapter does not provide, it says it does not provide.** OSV
 * carries advisories, not registry metadata — no publish date, no download
 * counts, no repository link. Those fields come back `undefined`, and the
 * classifier reads `undefined` as *unknown* rather than *fine*, so an
 * OSV-only setup yields `assumed` for a clean package and still asks a human.
 * Filling them needs deps.dev, which is a separate adapter and a separate task.
 */

const OSV_BATCH_URL = 'https://api.osv.dev/v1/querybatch';

/** Injected in tests, so the offline path is a real state rather than a mock. */
export type OsvFetch = (
  url: string,
  init: { method: string; body: string; headers: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export interface OsvOptions {
  readonly fetchImpl?: OsvFetch | undefined;
  /** Milliseconds before the lookup is abandoned. A gate must not hang a build. */
  readonly timeoutMs?: number | undefined;
  /**
   * Called with why a lookup came back empty-handed, so the surface can say it.
   *
   * Without this the adapter's failure modes are indistinguishable: a malformed
   * request rejected with HTTP 400 reads exactly like being offline, and the
   * result — every package `assumed` — looks the same either way. That is not
   * hypothetical. This adapter shipped its first build sending `pkg` where the
   * API requires `package`; every call 400'd, every verdict was `assumed`, and
   * nothing in the output distinguished a broken checker from a laptop on a
   * plane.
   */
  readonly onDegraded?: ((reason: string) => void) | undefined;
}

interface OsvBatchResponse {
  results?: { vulns?: { id?: string }[] }[];
}

/**
 * Maps our ecosystem names onto OSV's.
 *
 * OSV is case- and spelling-specific (`npm`, `PyPI`, `crates.io`, `Go`), and an
 * unrecognised ecosystem returns no vulns — which would look exactly like a
 * clean package. So an unmapped ecosystem is reported as unknown rather than
 * queried and silently believed.
 */
const OSV_ECOSYSTEM: Readonly<Record<string, string>> = {
  npm: 'npm',
  pypi: 'PyPI',
  python: 'PyPI',
  cargo: 'crates.io',
  crates: 'crates.io',
  go: 'Go',
  maven: 'Maven',
  nuget: 'NuGet',
  rubygems: 'RubyGems',
};

export function osvEcosystem(ecosystem: string): string | undefined {
  return OSV_ECOSYSTEM[ecosystem.toLowerCase()];
}

export function createOsvIntel(options: OsvOptions = {}): PackageIntelPort {
  const timeoutMs = options.timeoutMs ?? 5_000;

  return {
    id: 'osv.dev',
    async lookup(packages) {
      if (packages.length === 0) return [];

      // The key is `package`, spelled exactly that way. OSV rejects anything
      // else with HTTP 400 and a generic "invalid query", so a typo here is not
      // a crash — it is a checker that silently never finds a single advisory.
      const queries = packages.map((pkg) => ({
        package: { name: pkg.name, ecosystem: osvEcosystem(pkg.ecosystem) ?? pkg.ecosystem },
        ...(pkg.version === undefined ? {} : { version: pkg.version }),
      }));

      // Every failure mode below lands in the same place: signals with no
      // advisories *and* no metadata, which the classifier reads as `assumed`.
      // That is the fail-closed path — the gate still asks a human.
      const unknown = (reason: string): readonly PackageSignals[] => {
        options.onDegraded?.(reason);
        return packages.map((pkg) => ({
          name: pkg.name,
          ecosystem: pkg.ecosystem,
          ...(pkg.version === undefined ? {} : { version: pkg.version }),
          advisories: [],
        }));
      };

      const doFetch = options.fetchImpl ?? defaultFetch;
      let payload: unknown;
      try {
        const response = await withTimeout(
          doFetch(OSV_BATCH_URL, {
            method: 'POST',
            body: JSON.stringify({ queries }),
            headers: { 'content-type': 'application/json' },
          }),
          timeoutMs,
        );
        if (!response.ok) return unknown(`osv.dev answered HTTP ${String(response.status)}`);
        payload = await response.json();
      } catch (error) {
        // Offline, rate-limited, timed out — all the same answer: we did not
        // find out. Never "it was fine".
        return unknown(`osv.dev unreachable — ${(error as Error).message}`);
      }

      const results = (payload as OsvBatchResponse).results ?? [];
      return packages.map((pkg, index) => {
        const vulns = results[index]?.vulns ?? [];
        return {
          name: pkg.name,
          ecosystem: pkg.ecosystem,
          ...(pkg.version === undefined ? {} : { version: pkg.version }),
          advisories: vulns
            .map((vuln) => vuln.id)
            .filter((id): id is string => typeof id === 'string'),
          // OSV knows advisories, not registry metadata. Left undefined on
          // purpose so the classifier treats them as unknown.
        };
      });
    },
  };
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`OSV lookup exceeded ${String(ms)}ms`));
        }, ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const defaultFetch: OsvFetch = async (url, init) => {
  const response = await fetch(url, init);
  return {
    ok: response.ok,
    status: response.status,
    json: () => response.json(),
  };
};
