/**
 * Dangerous-command classification (P2-SEC-02, `.research/14 §(d)`, ADR-0036).
 *
 * Sits in front of the daemon's shell-exec path. The daemon runs commands, not
 * the agent, which is what makes a checkpoint here possible at all.
 *
 * `.research/14` looked for an off-the-shelf tool for agentic dangerous-command
 * interception and found no such product category, so this is ours to own. The
 * model it follows is `sudo` policy files and CODEOWNERS: **data-defined rules,
 * not per-agent-instance judgement**. A rule you can read, diff, and argue with
 * beats a classifier whose reasoning changes between runs.
 *
 * **Three verdicts, and the middle one is the point.**
 * - `refuse` — no approval path. Reserved for commands whose *only* readings are
 *   destructive.
 * - `approve` — a human decides. This is where most rules land, because most
 *   dangerous commands are also ordinary ones in the right context.
 * - `allow` — matched nothing.
 *
 * Collapsing `approve` into `refuse` is the failure mode that kills these
 * systems: `.research/14 §risks` names over-blocking explicitly, and a tool
 * that refuses `rm -rf ./dist` in a build script gets switched off within a
 * week, taking the rules that mattered with it.
 *
 * **Obfuscation (P2-SEC-07).** Rules are matched against the *normalised* text,
 * so `r""m -rf /` and `$IFS` padding no longer walk past a literal pattern. The
 * normaliser cannot be complete — deciding what an arbitrary shell program runs
 * is the halting problem wearing a `$` — so obfuscation is *also* a finding in
 * its own right: a command that base64-decodes into a shell needs a human
 * because it does that, whatever the payload turns out to be. An adversary who
 * defeats the unwrapping still trips that rule; an agent following an ordinary
 * plan trips neither.
 */

import { isDeliberatelyObfuscated, normalizeCommand } from './command-normalize.js';

export type CommandVerdict = 'refuse' | 'approve' | 'allow';

export interface CommandFinding {
  readonly rule: string;
  readonly verdict: Exclude<CommandVerdict, 'allow'>;
  readonly reason: string;
}

export interface CommandAssessment {
  readonly command: string;
  readonly verdict: CommandVerdict;
  readonly findings: readonly CommandFinding[];
  /** The text the rules were actually matched against. */
  readonly normalized: string;
  /** Obfuscation techniques observed, whether or not they were undone. */
  readonly techniques: readonly string[];
}

interface CommandRule {
  readonly id: string;
  readonly verdict: Exclude<CommandVerdict, 'allow'>;
  readonly pattern: RegExp;
  /**
   * An additional condition the command must also meet.
   *
   * Exists because some dangerous *words* are ordinary English. `DROP TABLE`
   * appears in migration notes, changelogs, and this file's own comments far
   * more often than in a command that drops a table, and a rule keyed on the
   * words alone flags `echo "DROP TABLE is a SQL statement" >> notes.md`.
   */
  readonly guard?: RegExp;
  readonly reason: string;
}

/** Programs that actually execute SQL, as opposed to text that mentions it. */
const SQL_CLIENT =
  /\b(?:psql|mysql|mariadb|sqlite3?|mongo(?:sh)?|cockroach|clickhouse-client|sqlcmd|prisma|knex|sequelize|flyway|liquibase|alembic)\b/i;

const RULES: readonly CommandRule[] = [
  {
    id: 'rm-rf-root',
    verdict: 'refuse',
    // `rm -rf /`, `rm -rf /*`, `rm -rf ~`. There is no context in which this is
    // the intended effect, so there is no approval path.
    pattern:
      /\brm\s+(?:-[a-zA-Z]*\s+)*-[a-zA-Z]*[rR][a-zA-Z]*f?[a-zA-Z]*\s+(?:\/|~)\s*\*?\s*(?:$|[;&|])/,
    reason: 'recursive delete of the filesystem root or home directory',
  },
  {
    id: 'rm-rf',
    verdict: 'approve',
    // Everything else recursive-forced. Usually `./dist`; occasionally not.
    pattern: /\brm\s+(?:-[a-zA-Z]+\s+)*-[a-zA-Z]*[rR]/,
    reason: 'recursive delete',
  },
  {
    id: 'pipe-to-shell',
    verdict: 'approve',
    // `curl … | sh` — the payload is chosen by whoever controls the URL, and
    // is unreviewable at the moment of running.
    pattern: /\b(?:curl|wget|fetch)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z|k|fi)?sh\b/,
    reason: 'downloads and executes a remote script in one step',
  },
  {
    id: 'destructive-sql',
    verdict: 'approve',
    pattern:
      /\b(?:DROP\s+(?:TABLE|DATABASE|SCHEMA)|TRUNCATE\s+TABLE|DELETE\s+FROM\s+\w+\s*(?:;|$))/i,
    // Only when something is actually there to run it. Mentioning `DROP TABLE`
    // in a note is not dropping a table.
    guard: SQL_CLIENT,
    reason: 'destructive SQL against a database this process cannot prove is disposable',
  },
  {
    id: 'force-push',
    verdict: 'approve',
    // Rewrites history someone else may have pulled. `--force-with-lease` is
    // deliberately included: it is safer, not safe.
    pattern: /\bgit\s+push\b[^\n]*\s--force(?:-with-lease)?\b|\bgit\s+push\b[^\n]*\s-f\b/,
    reason: 'force-push rewrites published history',
  },
  {
    id: 'git-hard-reset',
    verdict: 'approve',
    pattern: /\bgit\s+(?:reset\s+--hard|clean\s+(?:-[a-zA-Z]*\s+)*-[a-zA-Z]*[fd])/,
    reason: 'discards uncommitted work irrecoverably',
  },
  {
    id: 'permission-change',
    verdict: 'approve',
    pattern: /\b(?:chmod|chown)\b[^\n]*\s(?:777|a\+rwx|-R\b)/,
    reason: 'broad or recursive permission change',
  },
  {
    id: 'credential-read',
    verdict: 'approve',
    pattern:
      /\b(?:cat|less|more|head|tail|strings|xxd|base64)\b[^\n]*\.(?:env|pem|key|p12)\b|\b(?:cat|less|more|head|tail)\b[^\n]*(?:id_rsa|id_ed25519|\.aws\/credentials|\.ssh\/)/,
    reason: 'reads credential material',
  },
  {
    id: 'env-dump',
    verdict: 'approve',
    // `env | curl` and friends — the whole environment leaving the machine.
    pattern: /\b(?:env|printenv|set)\b\s*\|[^\n]*\b(?:curl|wget|nc|netcat)\b/,
    reason: 'sends the process environment off the machine',
  },
  {
    id: 'disable-history',
    verdict: 'approve',
    pattern: /\b(?:unset\s+HISTFILE|export\s+HISTSIZE=0|history\s+-c)\b/,
    reason: 'covers its own tracks',
  },
  {
    id: 'fork-bomb',
    verdict: 'refuse',
    pattern: /:\(\)\s*\{\s*:\|:&\s*\}\s*;\s*:/,
    reason: 'fork bomb',
  },
  {
    id: 'disk-overwrite',
    verdict: 'refuse',
    pattern: /\b(?:dd|mkfs(?:\.\w+)?)\b[^\n]*\bof=\/dev\/(?:sd|nvme|disk|hd)/,
    reason: 'overwrites a block device',
  },
];

/**
 * Classifies a command.
 *
 * Reports **every** matching rule, not the first. A command that both deletes
 * recursively and reads credentials is two problems, and a human deciding
 * whether to approve it needs both — an approval given against a partial
 * description is not informed consent.
 */
export function classifyCommand(command: string): CommandAssessment {
  const normalized = normalizeCommand(command);
  // Matched against the normalised text *and* the original: normalisation can
  // only remove noise, so a rule keyed on something the normaliser rewrote
  // would otherwise stop firing on the plain command it was written for.
  const subject = `${command}\n${normalized.text}`;

  const findings: CommandFinding[] = RULES.filter(
    (rule) => rule.pattern.test(subject) && (rule.guard?.test(subject) ?? true),
  ).map((rule) => ({
    rule: rule.id,
    verdict: rule.verdict,
    reason: rule.reason,
  }));

  if (isDeliberatelyObfuscated(normalized)) {
    findings.push({
      rule: 'obfuscated-command',
      verdict: 'approve',
      reason: `written to be hard to read (${normalized.techniques.join(', ')}) — nobody does this by accident`,
    });
  }

  const verdict: CommandVerdict = findings.some((f) => f.verdict === 'refuse')
    ? 'refuse'
    : findings.length > 0
      ? 'approve'
      : 'allow';

  return {
    command,
    verdict,
    findings,
    normalized: normalized.text,
    techniques: normalized.techniques,
  };
}

/**
 * Whether the daemon may run this command without asking.
 *
 * A separate named function rather than a comparison at each call site, so the
 * rule is importable and testable and there is exactly one place where "may we
 * run it" is decided.
 */
export function mayRunUnattended(assessment: CommandAssessment): boolean {
  return assessment.verdict === 'allow';
}
