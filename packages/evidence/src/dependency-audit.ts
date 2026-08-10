import { z } from 'zod';

/**
 * Dependency-audit evidence (P1-GATE-10, ADR-0044).
 *
 * **Non-blocking in v0.1, and that is a decision rather than an omission.** A
 * dependency advisory is a fact about the ecosystem, not about the change under
 * review: a task that touched one CSS file does not become unfit to merge
 * because a transitive dev dependency got an advisory this morning. Gating on it
 * would mean every work item in the repo failing simultaneously for a reason
 * none of them caused, which is how a gate stops being read.
 *
 * So it is recorded, surfaced, and left ungating — a signal the human decides
 * about. What makes that honest rather than lazy is that the evidence is real:
 * the audit actually runs, and the severity counts come from the tool's own
 * report rather than from anyone's summary of it.
 *
 * The shape here was read off `pnpm audit --json` (pnpm 10, 2026-08-10), not
 * assumed: top-level `advisories` keyed by numeric id, plus a `metadata` block
 * carrying the severity histogram. `npm audit --json` uses a different envelope
 * (`vulnerabilities` keyed by package name), so the parser accepts both rather
 * than pretending one shape is universal.
 */

export const AUDIT_SEVERITIES = ['info', 'low', 'moderate', 'high', 'critical'] as const;
export type AuditSeverity = (typeof AUDIT_SEVERITIES)[number];

export const DependencyAdvisorySchema = z.object({
  id: z.string().min(1),
  module: z.string().min(1),
  severity: z.enum(AUDIT_SEVERITIES),
  title: z.string(),
  vulnerable_versions: z.string(),
  patched_versions: z.string(),
  url: z.string(),
  /**
   * Whether every path to this advisory runs through a dev dependency.
   *
   * Kept because it changes what the finding means, not because it excuses it: a
   * dev-only advisory is a risk to the build machine, a runtime one is a risk to
   * the user. Collapsing them would make the count louder and less useful.
   */
  dev_only: z.boolean(),
  paths: z.array(z.string()),
});
export type DependencyAdvisory = z.infer<typeof DependencyAdvisorySchema>;

export const DependencyAuditSchema = z.object({
  tool: z.string().min(1),
  /** Counts by severity, from the tool's own report. */
  counts: z.object({
    info: z.number().int().nonnegative(),
    low: z.number().int().nonnegative(),
    moderate: z.number().int().nonnegative(),
    high: z.number().int().nonnegative(),
    critical: z.number().int().nonnegative(),
  }),
  total_dependencies: z.number().int().nonnegative(),
  advisories: z.array(DependencyAdvisorySchema),
  /**
   * Always true in v0.1 — recorded so a future policy change is visible in the
   * data rather than only in the code that read it. Evidence that does not say
   * whether it was gating cannot be replayed honestly.
   */
  advisory_only: z.literal(true),
});
export type DependencyAudit = z.infer<typeof DependencyAuditSchema>;

interface PnpmShape {
  advisories?: Record<
    string,
    {
      id?: number;
      module_name?: string;
      severity?: string;
      title?: string;
      vulnerable_versions?: string;
      patched_versions?: string;
      url?: string;
      findings?: { dev?: boolean; paths?: string[] }[];
    }
  >;
  metadata?: {
    vulnerabilities?: Partial<Record<AuditSeverity, number>>;
    totalDependencies?: number;
  };
}

interface NpmShape {
  vulnerabilities?: Record<
    string,
    {
      name?: string;
      severity?: string;
      via?: (string | { title?: string; url?: string; range?: string })[];
      range?: string;
      fixAvailable?: unknown;
      isDirect?: boolean;
    }
  >;
  metadata?: {
    vulnerabilities?: Partial<Record<AuditSeverity, number>>;
    dependencies?: { total?: number };
  };
}

export class AuditParseError extends Error {
  override readonly name = 'AuditParseError';
  constructor(reason: string) {
    super(`could not read the audit report: ${reason}`);
  }
}

function severityOf(raw: unknown): AuditSeverity {
  return AUDIT_SEVERITIES.includes(raw as AuditSeverity) ? (raw as AuditSeverity) : 'info';
}

function emptyCounts(): Record<AuditSeverity, number> {
  return { info: 0, low: 0, moderate: 0, high: 0, critical: 0 };
}

/**
 * Parses either audit dialect into one payload.
 *
 * The counts come from the report's own `metadata` when present rather than
 * being recomputed from the advisory list: one advisory can affect several
 * packages, and a recount would quietly disagree with what the tool printed to
 * the user's terminal.
 */
export function parseDependencyAudit(raw: string, tool = 'pnpm audit'): DependencyAudit {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new AuditParseError(`output is not valid JSON (${(cause as Error).message})`);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new AuditParseError('report is not an object');
  }

  const pnpm = parsed as PnpmShape;
  const npm = parsed as NpmShape;
  const counts = { ...emptyCounts(), ...(pnpm.metadata?.vulnerabilities ?? {}) };

  const advisories: DependencyAdvisory[] = [];
  if (pnpm.advisories !== undefined) {
    for (const [key, entry] of Object.entries(pnpm.advisories)) {
      const findings = entry.findings ?? [];
      const paths = findings.flatMap((finding) => finding.paths ?? []);
      advisories.push({
        id: entry.id === undefined ? key : String(entry.id),
        module: entry.module_name ?? '(unknown)',
        severity: severityOf(entry.severity),
        title: entry.title ?? '',
        vulnerable_versions: entry.vulnerable_versions ?? '',
        patched_versions: entry.patched_versions ?? '',
        url: entry.url ?? '',
        // Dev-only when *every* path is a dev path. One runtime path is enough
        // to make it a runtime risk, and `.some()` here would understate it.
        dev_only: findings.length > 0 && findings.every((finding) => finding.dev === true),
        paths,
      });
    }
  } else if (npm.vulnerabilities !== undefined) {
    for (const [name, entry] of Object.entries(npm.vulnerabilities)) {
      const detail = (entry.via ?? []).find((via) => typeof via === 'object') as
        { title?: string; url?: string; range?: string } | undefined;
      advisories.push({
        id: name,
        module: entry.name ?? name,
        severity: severityOf(entry.severity),
        title: detail?.title ?? '',
        vulnerable_versions: entry.range ?? detail?.range ?? '',
        patched_versions: '',
        url: detail?.url ?? '',
        // npm's report does not distinguish dev paths at this level. Recorded as
        // false rather than guessed — an invented distinction is worse than a
        // missing one.
        dev_only: false,
        paths: [],
      });
    }
  } else {
    throw new AuditParseError(
      'no `advisories` (pnpm) or `vulnerabilities` (npm) section — is this an audit report?',
    );
  }

  return DependencyAuditSchema.parse({
    tool,
    counts,
    total_dependencies: pnpm.metadata?.totalDependencies ?? npm.metadata?.dependencies?.total ?? 0,
    advisories: advisories.sort((a, b) => a.id.localeCompare(b.id)),
    advisory_only: true,
  });
}

/**
 * A one-line summary for the CLI.
 *
 * "0 advisories" and "advisories found but not gating" must read differently —
 * a clean audit and an ignored one look identical if the wording is careless.
 */
export function summariseAudit(audit: DependencyAudit): string {
  const total = AUDIT_SEVERITIES.reduce((sum, severity) => sum + audit.counts[severity], 0);
  if (total === 0)
    return `${audit.tool}: no advisories across ${String(audit.total_dependencies)} dependencies`;

  const parts = AUDIT_SEVERITIES.filter((severity) => audit.counts[severity] > 0)
    .reverse()
    .map((severity) => `${String(audit.counts[severity])} ${severity}`);
  return `${audit.tool}: ${parts.join(', ')} — advisory only, this does not block (P1-GATE-10)`;
}
