/**
 * The revert-reintroduction guard (P2-GIT-01, FEAT-GIT-012, `.research/techniques/27`).
 *
 * The failure mode is specific and documented: an agent re-adds code that was
 * reverted last month, because nothing in its context says the revert happened
 * or why. The revert is in the history; the agent is not reading the history.
 *
 * **Matching is by entity, not by file path.** `.research/27` is explicit about
 * why: a fresh migration number, a renamed file, or a move to a different
 * directory all slip past a path-based check while re-adding exactly the thing
 * that was removed. What was reverted was a table, a function, a flag — not a
 * line number.
 *
 * **The open design question, settled and stated.** `.research/27 §risks`
 * leaves the depth open: AST-level entity identity or heuristic symbol
 * matching. This takes the heuristic route, for a reason that is not
 * expedience — an AST parser only understands languages it has a grammar for,
 * and a large share of real reverts are SQL migrations, CI YAML, and config.
 * A guard that silently covers TypeScript and silently misses the migration
 * that was reverted for corrupting production is worse than one whose limits
 * are legible.
 *
 * So: declaration-shaped symbols, extracted by pattern, across the languages a
 * repo actually reverts things in. It over-matches on common names, and the
 * response to that is the design below — this **warns and requires
 * acknowledgment**; it never blocks. A guard that blocks on a name collision is
 * a guard that gets bypassed by habit within a fortnight.
 */

export interface RevertedEntity {
  readonly name: string;
  /** The revert commit that removed it. */
  readonly revertSha: string;
  /** The revert's subject line — usually the only explanation anyone wrote. */
  readonly subject: string;
}

export interface ReintroductionFinding {
  readonly entity: string;
  readonly revertSha: string;
  readonly subject: string;
  /** True when a commit-message trailer explicitly acknowledged this. */
  readonly acknowledged: boolean;
}

/**
 * Declaration patterns, per language family.
 *
 * Only *declarations* — a call site is a use, not a reintroduction, and
 * matching uses would fire on every file that merely references the name.
 */
const DECLARATIONS: readonly RegExp[] = [
  // TS/JS
  /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
  /(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/g,
  /(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[:=]/g,
  /(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/g,
  // Python / Ruby
  /^\s*def\s+([A-Za-z_]\w*)/gm,
  // SQL — the case a path-based check misses most often, because the next
  // migration gets a new filename and looks like new work.
  /CREATE\s+(?:TABLE|INDEX|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`]?([A-Za-z_]\w*)/gi,
  /ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`]?([A-Za-z_]\w*)/gi,
  // Config keys and feature flags, which are reverted about as often as code.
  /^\s*["']?([A-Za-z_][\w.-]{3,})["']?\s*:\s*(?:true|false|\d)/gm,
];

/**
 * Names too common to carry information.
 *
 * Without this the guard fires on every diff that declares a `handler` or a
 * `config`, and a guard that fires on every diff is noise wearing a warning's
 * clothes.
 */
const TOO_COMMON = new Set([
  'index',
  'main',
  'handler',
  'config',
  'options',
  'result',
  'data',
  'value',
  'name',
  'type',
  'id',
  'key',
  'item',
  'error',
  'default',
  'props',
  'state',
  'test',
  'setup',
  'run',
  'init',
  'get',
  'set',
]);

const MIN_NAME_LENGTH = 4;

/** Declaration-shaped symbols in a body of text. */
export function extractEntities(text: string): readonly string[] {
  const found = new Set<string>();
  for (const pattern of DECLARATIONS) {
    for (const match of text.matchAll(pattern)) {
      const name = match[1];
      if (name === undefined) continue;
      if (name.length < MIN_NAME_LENGTH) continue;
      if (TOO_COMMON.has(name.toLowerCase())) continue;
      found.add(name);
    }
  }
  return [...found].sort();
}

/** Only the lines a diff removes — what the revert actually took out. */
export function removedLines(diff: string): string {
  return diff
    .split('\n')
    .filter((line) => line.startsWith('-') && !line.startsWith('---'))
    .map((line) => line.slice(1))
    .join('\n');
}

/** Only the lines a diff adds. */
export function addedLines(diff: string): string {
  return diff
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .map((line) => line.slice(1))
    .join('\n');
}

/**
 * The trailer that acknowledges a deliberate reintroduction.
 *
 * A git trailer rather than a config file or a CLI flag, so the reason travels
 * with the commit and shows up in `git log` and in the PR diff. Someone asking
 * "why is this back?" in a year gets an answer from `git blame` rather than
 * from whoever still remembers.
 */
const REINTRODUCES = /^Reintroduces:\s*(\S+)(?:\s*—|\s*--|\s*-)?\s*(.*)$/gim;

export function acknowledgedEntities(commitMessage: string): readonly string[] {
  return [...commitMessage.matchAll(REINTRODUCES)]
    .map((match) => match[1])
    .filter((name): name is string => name !== undefined);
}

export interface GuardResult {
  readonly findings: readonly ReintroductionFinding[];
  /** Findings still needing acknowledgment. */
  readonly unacknowledged: readonly ReintroductionFinding[];
  readonly clean: boolean;
}

/**
 * Whether a change re-adds something a past revert removed.
 *
 * Acknowledged findings stay in the result rather than being filtered out: the
 * reviewer should see that this *is* a reintroduction and that somebody said so
 * on purpose. Dropping them would make a deliberate reintroduction
 * indistinguishable from one nobody noticed.
 */
export function checkReintroduction(
  reverted: readonly RevertedEntity[],
  addedText: string,
  commitMessage = '',
): GuardResult {
  const added = new Set(extractEntities(addedText));
  const acknowledged = new Set(acknowledgedEntities(commitMessage));

  const seen = new Set<string>();
  const findings: ReintroductionFinding[] = [];

  for (const entity of reverted) {
    if (!added.has(entity.name)) continue;
    // One finding per entity: the same symbol reverted twice is one question.
    const key = `${entity.name}:${entity.revertSha}`;
    if (seen.has(key)) continue;
    seen.add(key);

    findings.push({
      entity: entity.name,
      revertSha: entity.revertSha,
      subject: entity.subject,
      acknowledged: acknowledged.has(entity.name),
    });
  }

  findings.sort((a, b) => a.entity.localeCompare(b.entity));
  const unacknowledged = findings.filter((finding) => !finding.acknowledged);

  return { findings, unacknowledged, clean: unacknowledged.length === 0 };
}

export function formatGuard(result: GuardResult): string {
  if (result.findings.length === 0) {
    return '✓ nothing in this change was previously reverted';
  }

  const lines: string[] = [];
  for (const finding of result.findings) {
    lines.push(
      `${finding.acknowledged ? '✓ acknowledged' : '⚠ REINTRODUCED'} ${finding.entity} — removed by ${finding.revertSha.slice(0, 8)}: ${finding.subject}`,
    );
  }

  if (result.unacknowledged.length > 0) {
    lines.push(
      '',
      'These were reverted before. That does not mean they are wrong now — it means',
      'somebody removed them deliberately and the reason may still hold. If it does',
      'not, say so in the commit message and this stops asking:',
      '',
      ...result.unacknowledged.map(
        (finding) =>
          `  Reintroduces: ${finding.entity} — <why the original revert no longer applies>`,
      ),
    );
  }
  return lines.join('\n');
}
