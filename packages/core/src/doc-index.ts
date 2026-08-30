/**
 * Browsable indexes over the doc mirror (P6-SURFACE-04, FEAT-UI-006/007).
 *
 * Two views on the same table, and each exists because the thing it indexes has
 * been findable only by knowing where to look.
 *
 * **Research** was a first-class output that behaved like a scratch file: a
 * `research` doc records what was found and which work items asked for it, and
 * nothing ever grouped them. So the index leads with the number that says
 * whether the discipline is working — how much research is linked to nothing.
 *
 * **Decisions** are the institutional memory of *why*, and the part that rots
 * is the supersession chain. An ADR that says `superseded` with no pointer, or
 * a pointer to an ADR that does not exist, leaves a reader at a dead end while
 * every individual document still looks fine. Both are surfaced here, because a
 * decision log that renders a broken chain as a clean list is worse than none.
 */

/** One row from the `docs` mirror, as the API hands it over. */
export interface DocRow {
  readonly id: string;
  readonly docType: string;
  readonly filePath: string;
  readonly title: string | null;
  readonly metadata: Record<string, unknown> | null;
  readonly updatedAt: string;
}

/* ------------------------------------------------------------------- research */

export interface ResearchEntry {
  readonly id: string;
  readonly title: string;
  readonly filePath: string;
  readonly topic: string;
  readonly relatedWorkItems: readonly string[];
  readonly sources: readonly string[];
  readonly updatedAt: string;
}

export interface ResearchIndex {
  readonly byTopic: readonly {
    readonly topic: string;
    readonly entries: readonly ResearchEntry[];
  }[];
  readonly total: number;
  /** Research nothing asked for — the number that says whether the habit is working. */
  readonly unlinked: readonly string[];
  /** Research citing no source at all. Not an error; a note, not a finding. */
  readonly uncited: readonly string[];
  readonly because: string;
}

function stringsFrom(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry !== '');
}

const UNTOPICED = '(no topic)';

export function researchIndex(docs: readonly DocRow[]): ResearchIndex {
  const entries: ResearchEntry[] = docs
    .filter((doc) => doc.docType === 'research')
    .map((doc) => {
      const metadata = doc.metadata ?? {};
      const topic = typeof metadata['topic'] === 'string' ? metadata['topic'] : '';
      return {
        id: doc.id,
        // The path, never a generated name: a research note whose title is
        // missing is a real state, and inventing one hides that the frontmatter
        // is incomplete.
        title: doc.title ?? doc.filePath,
        filePath: doc.filePath,
        topic: topic === '' ? UNTOPICED : topic,
        relatedWorkItems: stringsFrom(metadata['related_work_items']),
        sources: stringsFrom(metadata['sources']),
        updatedAt: doc.updatedAt,
      };
    });

  const topics = [...new Set(entries.map((entry) => entry.topic))].sort((a, b) => {
    // `(no topic)` sorts last however it compares alphabetically — it is a gap,
    // not a category, and putting it first would make the index open on it.
    if (a === UNTOPICED) return 1;
    if (b === UNTOPICED) return -1;
    return a.localeCompare(b);
  });

  return {
    byTopic: topics.map((topic) => ({
      topic,
      entries: entries
        .filter((entry) => entry.topic === topic)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    })),
    total: entries.length,
    unlinked: entries.filter((entry) => entry.relatedWorkItems.length === 0).map((e) => e.id),
    uncited: entries.filter((entry) => entry.sources.length === 0).map((e) => e.id),
    because:
      entries.length === 0
        ? 'no research recorded yet'
        : `${String(entries.length)} note(s) across ${String(topics.length)} topic(s)`,
  };
}

/* ------------------------------------------------------------------ decisions */

export interface DecisionEntry {
  readonly id: string;
  /** The declared `adr_id`, or the doc id when there is none. See {@link DecisionEntry.identified}. */
  readonly adrId: string;
  /**
   * Whether this record actually declares an `adr_id`.
   *
   * `doc_type` is assigned by **directory**, so an index README living beside
   * the ADRs is classified a decision and arrives here with no id of its own.
   * Falling back to the doc id keeps it in the log — losing it would be worse —
   * but the fallback is a file path, and a file path rendered as an ADR id
   * reads like a real record. This flag is what lets the view say otherwise.
   */
  readonly identified: boolean;
  readonly title: string;
  readonly filePath: string;
  readonly status: string;
  readonly supersedes: string | null;
  readonly supersededBy: string | null;
  readonly updatedAt: string;
}

export type ChainProblem =
  'dangling-successor' | 'dangling-predecessor' | 'superseded-without-successor' | 'cycle';

export interface ChainIssue {
  readonly adrId: string;
  readonly problem: ChainProblem;
  readonly because: string;
}

export interface DecisionLog {
  readonly entries: readonly DecisionEntry[];
  /** Records in the decisions directory that declare no `adr_id` — an index, usually. */
  readonly unidentified: readonly string[];
  /** Chains, newest decision first. A single-element chain is a decision nobody has revisited. */
  readonly chains: readonly (readonly string[])[];
  readonly issues: readonly ChainIssue[];
  readonly because: string;
}

export function decisionLog(docs: readonly DocRow[]): DecisionLog {
  const entries: DecisionEntry[] = docs
    .filter((doc) => doc.docType === 'decision')
    .map((doc) => {
      const metadata = doc.metadata ?? {};
      const value = (key: string): string | null => {
        const raw = metadata[key];
        return typeof raw === 'string' && raw !== '' ? raw : null;
      };
      const declared = value('adr_id');
      return {
        id: doc.id,
        adrId: declared ?? doc.id,
        identified: declared !== null,
        title: doc.title ?? doc.filePath,
        filePath: doc.filePath,
        status: value('status') ?? 'unknown',
        supersedes: value('supersedes'),
        supersededBy: value('superseded_by'),
        updatedAt: doc.updatedAt,
      };
    })
    .sort((a, b) => a.adrId.localeCompare(b.adrId));

  const byAdr = new Map(entries.map((entry) => [entry.adrId, entry]));
  const issues: ChainIssue[] = [];

  for (const entry of entries) {
    if (entry.supersededBy !== null && !byAdr.has(entry.supersededBy)) {
      issues.push({
        adrId: entry.adrId,
        problem: 'dangling-successor',
        because: `points at ${entry.supersededBy}, which is not in the log — the reader ends at a dead end`,
      });
    }
    if (entry.supersedes !== null && !byAdr.has(entry.supersedes)) {
      issues.push({
        adrId: entry.adrId,
        problem: 'dangling-predecessor',
        because: `claims to supersede ${entry.supersedes}, which is not in the log`,
      });
    }
    if (entry.status === 'superseded' && entry.supersededBy === null) {
      issues.push({
        adrId: entry.adrId,
        problem: 'superseded-without-successor',
        because: 'marked superseded with nothing naming the replacement',
      });
    }
  }

  // Chains are walked **forward**, from each decision nothing replaces.
  //
  // The head of a chain is an ADR that no other entry points at with
  // `superseded_by` — not one that supersedes nothing, which is the tail. The
  // two are easy to swap and the symptom is a log that renders every chain
  // starting at its own end.
  const pointedAt = new Set(
    entries.map((entry) => entry.supersededBy).filter((id): id is string => id !== null),
  );
  const chains: string[][] = [];
  const visited = new Set<string>();

  const walk = (start: DecisionEntry): string[] => {
    const chain: string[] = [];
    const guard = new Set<string>();
    let cursor: DecisionEntry | undefined = start;
    while (cursor !== undefined) {
      if (guard.has(cursor.adrId)) {
        // `superseded_by` is hand-edited, so A → B → A is one typo away. A walk
        // that trusted it would hang rather than report it.
        issues.push({
          adrId: cursor.adrId,
          problem: 'cycle',
          because: 'the supersession chain loops back on itself',
        });
        break;
      }
      guard.add(cursor.adrId);
      visited.add(cursor.adrId);
      chain.push(cursor.adrId);
      cursor = cursor.supersededBy === null ? undefined : byAdr.get(cursor.supersededBy);
    }
    return chain;
  };

  for (const entry of entries) {
    if (pointedAt.has(entry.adrId)) continue;
    chains.push(walk(entry));
  }

  // A cycle has no head, so the pass above never reaches it and the decisions
  // in it would vanish from a log whose whole job is not losing them. Every
  // entry no chain reached starts one of its own.
  for (const entry of entries) {
    if (visited.has(entry.adrId)) continue;
    chains.push(walk(entry));
  }

  const unidentified = entries.filter((entry) => !entry.identified).map((entry) => entry.id);

  return {
    entries,
    unidentified,
    chains,
    issues,
    because:
      entries.length === 0
        ? 'no decisions recorded yet'
        : `${String(entries.length)} decision(s) in ${String(chains.length)} chain(s)${issues.length === 0 ? '' : `, ${String(issues.length)} chain problem(s)`}${unidentified.length === 0 ? '' : `, ${String(unidentified.length)} without an adr_id`}`,
  };
}
