/**
 * The doc-freshness check (P1-DOC-01, ADR-0046).
 *
 * ADR-0046's rule is that a doc contradicted by the code is a defect, not
 * acceptable debt. Its own consequences section is honest about the enforcement:
 * "update the doc every iteration" is real overhead and easy to skip under
 * pressure, and any automated check is **heuristic** — it cannot prove semantic
 * staleness.
 *
 * So this catches the four kinds of drift that are decidable in code, and
 * nothing else. That boundary is deliberate. A check that guessed at semantic
 * rot would produce findings nobody could act on, and a doc-quality gate people
 * learn to ignore is worse than no gate: it converts "we do not know if the docs
 * are current" into "the docs passed."
 *
 * Everything here **advises** rather than blocks, except the one signal that is
 * a fact rather than a heuristic — a link that resolves to nothing.
 */

export type DriftKind =
  'code-changed-doc-did-not' | 'refresh-by-expired' | 'broken-link' | 'count-drift';

export interface DriftFinding {
  readonly kind: DriftKind;
  readonly doc: string;
  readonly detail: string;
  /** Only a broken link gates; the rest are signals a human weighs. */
  readonly gating: boolean;
}

export interface DocRecord {
  readonly path: string;
  /** Code paths this doc claims to describe. */
  readonly covers: readonly string[];
  /** ISO date after which the doc must be re-checked (ADR-0045 tech research). */
  readonly refreshBy?: string | undefined;
  /** Links the doc makes, with whether each resolves. */
  readonly links?: readonly { readonly target: string; readonly resolves: boolean }[] | undefined;
  /** A count the doc asserts, and the real one, when both are known. */
  readonly counts?:
    | readonly { readonly label: string; readonly claimed: number; readonly actual: number }[]
    | undefined;
}

export interface FreshnessInput {
  readonly docs: readonly DocRecord[];
  /** Files changed in the window being checked. */
  readonly changedFiles: readonly string[];
  /** Docs changed in the same window. */
  readonly changedDocs: readonly string[];
  readonly now: Date;
}

export interface FreshnessReport {
  readonly findings: readonly DriftFinding[];
  /** False only when something *gating* drifted. Advisory findings never fail it. */
  readonly ok: boolean;
  readonly advisory: readonly DriftFinding[];
}

/**
 * Reports documentation drift.
 *
 * Pure — the git window, the link resolution and the counts all arrive as
 * arguments. A check that went and looked would be reporting on the tree it
 * happened to find rather than the change under review.
 */
export function checkFreshness(input: FreshnessInput): FreshnessReport {
  const findings: DriftFinding[] = [];
  const changedDocs = new Set(input.changedDocs);

  for (const doc of input.docs) {
    const touched = doc.covers.filter((glob) =>
      input.changedFiles.some((file) => matches(glob, file)),
    );
    if (touched.length > 0 && !changedDocs.has(doc.path)) {
      findings.push({
        kind: 'code-changed-doc-did-not',
        doc: doc.path,
        detail: `describes ${touched.join(', ')}, which changed while the doc did not`,
        // Advisory: plenty of code changes do not affect what a doc says, and a
        // gate here would be failed by every rename.
        gating: false,
      });
    }

    if (doc.refreshBy !== undefined && Date.parse(doc.refreshBy) < input.now.getTime()) {
      findings.push({
        kind: 'refresh-by-expired',
        doc: doc.path,
        // The one class that goes stale on a clock rather than on a code change
        // (ADR-0045): a library's docs move whether or not this repo does.
        detail: `refresh-by ${doc.refreshBy} has passed — tech research goes stale on a clock, not on a diff`,
        gating: false,
      });
    }

    for (const link of doc.links ?? []) {
      if (!link.resolves) {
        findings.push({
          kind: 'broken-link',
          doc: doc.path,
          detail: `links to ${link.target}, which does not exist`,
          // The one fact here. A link either resolves or it does not, and a
          // reader following it lands nowhere — no judgement involved.
          gating: true,
        });
      }
    }

    for (const count of doc.counts ?? []) {
      if (count.claimed !== count.actual) {
        findings.push({
          kind: 'count-drift',
          doc: doc.path,
          detail: `says ${String(count.claimed)} ${count.label}, there are ${String(count.actual)}`,
          gating: false,
        });
      }
    }
  }

  const gating = findings.filter((finding) => finding.gating);
  return {
    findings,
    ok: gating.length === 0,
    advisory: findings.filter((finding) => !finding.gating),
  };
}

/** Minimal glob support — `**` and `*`. Path scopes need no more. */
function matches(glob: string, file: string): boolean {
  const pattern = glob
    .split('**')
    .map((part) => part.split('*').map(escapeRegex).join('[^/]*'))
    .join('.*');
  return new RegExp(`^${pattern}$`).test(file);
}

function escapeRegex(text: string): string {
  return text.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

/* --------------------------------------------------------------- the three logs */

export interface HistoryEntry {
  readonly date: string;
  readonly summary: string;
  readonly workItemId?: string | undefined;
}

/**
 * `HISTORY.md` — what was done, one line per change.
 *
 * Concise by construction, because ADR-0046 names essay-length entries as the
 * thing that makes the discipline collapse. A log nobody can skim is a log
 * nobody reads, and a log nobody reads stops being written.
 */
export function renderHistory(entries: readonly HistoryEntry[]): string {
  const lines = ['# History', '', 'What was done, one line per change. Newest first.', ''];
  for (const entry of [...entries].sort((a, b) => (a.date < b.date ? 1 : -1))) {
    const id = entry.workItemId === undefined ? '' : `${entry.workItemId} — `;
    lines.push(`- **${entry.date}** ${id}${oneLine(entry.summary)}`);
  }
  return `${lines.join('\n')}\n`;
}

export interface DecisionChange {
  readonly date: string;
  readonly adr: string;
  readonly kind: 'reversed' | 'amended' | 'superseded';
  readonly because: string;
  readonly supersededBy?: string | undefined;
}

/**
 * `DECISION.md` — a log of decision *changes*, not of decisions.
 *
 * The ADRs remain authoritative; this is the chronological index of what changed
 * our mind and when. Duplicating the rationale here would create a second
 * account of the same decision, and two accounts disagree eventually — the
 * failure ADR-0053 is about.
 */
export function renderDecisionLog(changes: readonly DecisionChange[]): string {
  const lines = [
    '# Decision changes',
    '',
    'When a decision changed, and which ADR owns the reasoning. The ADR is',
    'authoritative; this is the chronological index into it.',
    '',
  ];
  for (const change of [...changes].sort((a, b) => (a.date < b.date ? 1 : -1))) {
    const to = change.supersededBy === undefined ? '' : ` → ${change.supersededBy}`;
    lines.push(
      `- **${change.date}** ${change.adr} ${change.kind}${to} — ${oneLine(change.because)}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

/** Collapses to one line. The concision rule enforced rather than requested. */
function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= 160 ? flat : `${flat.slice(0, 157)}…`;
}
