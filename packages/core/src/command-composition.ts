/**
 * Command-composition risk — a spike, not a shipped classifier (P8-SEC-01,
 * closing the build half of [Q-05]).
 *
 * ## The problem, with numbers
 *
 * [ADR-0038](../../../docs/.plan/decisions/ADR-0038-session-aware-command-risk.md)
 * commits to a session-risk layer and Q-05 recorded that the literature offers
 * the attack taxonomy with **no mature detector**. Checked again 2026-08-31
 * against MOSAIC (arXiv:2607.02857, tier A — the paper itself, fetched not
 * recalled), and that is still true, with figures worth quoting because they
 * set the bar:
 *
 * | Defense | Detection rate |
 * |---|---|
 * | PromptGuard 2 (instruction scanner) | **0%** |
 * | Progent (capability control) | **0%** |
 * | CaMeL (information-flow control) | **0%** |
 * | Semgrep (command/resource scanner) | 13.27% |
 * | AlignmentCheck (task-alignment monitor) | **17.43%** |
 *
 * The paper's own summary: *"None of these defenses detects CCR by capturing
 * the security impact that the benign CLI command combination produces."*
 *
 * The attack shape is a **state dependency**: *"a state dependency holds from
 * an earlier command `cᵢ` to a later command `cⱼ` when `cᵢ` writes state that
 * `cⱼ` later reads or acts on."* Every command is individually harmless, so a
 * per-command check — which is what `dangerous-command.ts` is — cannot see it
 * by construction. The composition is the attack.
 *
 * ## What this module does, and what it deliberately does not
 *
 * It finds **producer→consumer edges over a command trace**, on a small set of
 * documented state channels, and reports them. That is all.
 *
 * It does **not** decide whether an edge is an attack. Q-05's own instruction
 * was *"start narrow (documented patterns only), sandbox-as-backstop"*, and a
 * module that graded intent would be a model's opinion sitting in the one place
 * this product refuses one. An edge is a **fact about a trace**: this run wrote
 * a git hook and then ran `git commit`. Whether that is a build step or an
 * exploit is a question for a human, and the honest output is the edge plus the
 * evidence for it.
 *
 * ## Why an agent trace makes this tractable when a shell history does not
 *
 * The producer must be **this session's own write**. A repository that already
 * contains a `.git/hooks/pre-commit` and then runs `git commit` is every
 * ordinary project on earth; a run that *wrote* that hook and then ran `git
 * commit` is the pattern. The distinction needs a record of what the session
 * did, which is exactly what [ADR-0039](../../../docs/.plan/decisions/ADR-0039-semantic-checkpoint-idempotency.md)'s
 * already-happened ledger provides — and is why Q-05 said to wait for it.
 *
 * Without that record the false-positive rate is unusable, and the measured
 * numbers in the spike report say so.
 */

/**
 * The channels, drawn from MOSAIC's thirteen command-state families.
 *
 * Five, not thirteen, and the five are the ones whose producer and consumer are
 * both **syntactically recognisable without executing anything**. The other
 * eight — terminal escape sequences, argv boundaries, IFS word splitting,
 * chroot boundaries — need either execution or a shell parser, and a detector
 * that half-parses a shell is worse than one that admits its scope.
 */
export const STATE_CHANNELS = [
  'git-hook',
  'package-lifecycle',
  'path-shadowing',
  'git-config',
  'submodule',
] as const;
export type StateChannel = (typeof STATE_CHANNELS)[number];

export interface TraceStep {
  /** Position in the trace. Order is the whole point. */
  readonly index: number;
  /** The command as run. */
  readonly command: string;
  /** Paths this step wrote, as recorded by the session — not inferred from the command. */
  readonly wrote?: readonly string[] | undefined;
}

export interface CompositionEdge {
  readonly channel: StateChannel;
  readonly producer: number;
  readonly consumer: number;
  /** The specific state that links them. */
  readonly via: string;
  readonly because: string;
}

const PACKAGE_MANAGER =
  /\b(npm|pnpm|yarn|bun)\s+(install|i|add|ci)\b|\bpip\s+install\b|\b(cargo|bundle)\s+(build|install)\b/;

function isPackageManager(command: string): boolean {
  return PACKAGE_MANAGER.test(command);
}

function basename(filePath: string): string {
  return (
    filePath
      .split('/')
      .filter((part) => part !== '')
      .pop() ?? filePath
  );
}

/**
 * Whether a command invokes `name` as a program rather than merely mentioning it.
 *
 * Matches at a command position — the start of the line, or after a separator
 * (`;`, `&&`, `||`, `|`) — with an optional `./` or directory prefix. Anything
 * looser matches a filename in an argument list, which is how the first
 * version of this rule produced 653 edges from one write.
 */
function invokesName(command: string, name: string): boolean {
  if (name === '') return false;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[;|&]\\s*)\\s*(\\S*/)?${escaped}(\\s|$)`).test(command);
}

interface ChannelRule {
  readonly channel: StateChannel;
  /** Does this step write into the channel? Returns the path/name it wrote. */
  readonly produces: (step: TraceStep) => string | null;
  /** Does this step act on state from the channel? */
  readonly consumes: (command: string) => boolean;
  /**
   * A consumer test that also sees *what* was written.
   *
   * Present only where the channel needs it — `path-shadowing` must know the
   * name to look for, and a rule that ignores it links every command to every
   * write. When present it is used instead of {@link ChannelRule.consumes}.
   */
  readonly consumesWritten?: (command: string, via: string) => boolean;
  readonly because: (via: string) => string;
}

const wrote = (step: TraceStep, test: RegExp): string | null =>
  (step.wrote ?? []).find((path) => test.test(path)) ?? null;

/**
 * Each rule names one documented family and matches only what it can see.
 *
 * The `produces` side reads the session's **recorded writes**, never the
 * command text. `echo x > .git/hooks/pre-commit` and a Python script that opens
 * the same path are the same event, and only one of them looks like a write.
 */
const RULES: readonly ChannelRule[] = [
  {
    channel: 'git-hook',
    produces: (step) => wrote(step, /(^|\/)\.git\/hooks\//),
    // Any git operation that fires a hook. `status` and `log` do not.
    consumes: (command) =>
      /\bgit\s+(commit|push|merge|checkout|rebase|am|applypatch)\b/.test(command),
    because: (via) =>
      `this run wrote the git hook ${via} and then ran a git operation that executes hooks — the hook runs with the agent's privileges and outside any per-command check`,
  },
  {
    channel: 'package-lifecycle',
    // A package manager is **not** a producer on its own channel, even though
    // it writes the manifest. `pnpm add x` then `pnpm install` is the most
    // ordinary sequence in any repository, and treating the first as a producer
    // fired on it every time. Measured: this rule alone produced three of the
    // five flagged traces in the spike, all three of them installs.
    produces: (step) =>
      isPackageManager(step.command)
        ? null
        : wrote(step, /(^|\/)(package\.json|pyproject\.toml|setup\.py|Cargo\.toml|Gemfile)$/),
    consumes: isPackageManager,
    because: (via) =>
      `this run wrote ${via} with something other than a package manager and then invoked one — lifecycle scripts in a manifest execute on install, so the write chose what the next command would run`,
  },
  {
    channel: 'path-shadowing',
    // A write of an executable into a directory a later command could resolve
    // through PATH.
    produces: (step) => wrote(step, /(^|\/)(bin|sbin|\.local\/bin|node_modules\/\.bin)\//),
    // **The consumer must actually invoke that name.** The first version said
    // "any non-empty command", which is true of the threat model and useless as
    // a detector: one write into `./bin/` linked to every subsequent step, so a
    // 96-step CI job produced 95 edges from a single write. Measured on real
    // pipelines it generated **653 of 656 total edges** — 99.5% of the output
    // from one rule. Quadratic noise is not a signal, and a detector nobody can
    // read is one nobody runs.
    consumes: () => false,
    consumesWritten: (command, via) => invokesName(command, basename(via)),
    because: (via) =>
      `this run wrote the executable ${via} and then invoked it by name — a bare name resolves to whatever the search path finds first`,
  },
  {
    channel: 'git-config',
    produces: (step) =>
      wrote(step, /(^|\/)\.git\/config$/) ??
      (/\bgit\s+config\b/.test(step.command) ? 'git config' : null),
    consumes: (command) => /\bgit\s+(fetch|pull|push|clone|submodule|remote)\b/.test(command),
    because: (via) =>
      `this run changed git configuration (${via}) and then ran a command that reads it — config decides remotes, credential helpers and hook paths`,
  },
  {
    channel: 'submodule',
    produces: (step) => wrote(step, /(^|\/)\.gitmodules$/),
    consumes: (command) =>
      /\bgit\s+submodule\b/.test(command) || /\bgit\s+clone\b.*--recurse/.test(command),
    because: (via) =>
      `this run wrote ${via} and then updated submodules — the file names the URLs that are then fetched and checked out`,
  },
];

/**
 * Producer→consumer edges in a trace.
 *
 * **Order-sensitive and non-transitive.** A consumer is linked to every earlier
 * producer on the same channel, not only the nearest one: two hooks written by
 * different steps are two separate facts, and collapsing them would hide the
 * second.
 *
 * Returns an empty array for a trace with no edges — which is not a statement
 * that the trace is safe. This detector covers five of thirteen documented
 * families, and the ones it declines are named in {@link STATE_CHANNELS}'s note.
 */
export function compositionEdges(trace: readonly TraceStep[]): readonly CompositionEdge[] {
  const ordered = [...trace].sort((a, b) => a.index - b.index);
  const edges: CompositionEdge[] = [];

  for (const rule of RULES) {
    const produced: { index: number; via: string }[] = [];
    for (const step of ordered) {
      // `produced` holds only steps strictly earlier than this one, because a
      // step is pushed *after* its own consumption check below. That ordering
      // is what makes a self-edge impossible — a step cannot consume its own
      // write, since the write happens as part of running it.
      //
      // An explicit `producer.index >= step.index` guard used to sit here and a
      // mutation run proved it could not fire. A guard that cannot fire is not
      // defence; it is a claim about the code that the code already makes, and
      // this repository removes those rather than testing around them.
      for (const producer of produced) {
        const consumed =
          rule.consumesWritten === undefined
            ? rule.consumes(step.command)
            : rule.consumesWritten(step.command, producer.via);
        if (consumed) {
          edges.push({
            channel: rule.channel,
            producer: producer.index,
            consumer: step.index,
            via: producer.via,
            because: rule.because(producer.via),
          });
        }
      }
      const via = rule.produces(step);
      if (via !== null) produced.push({ index: step.index, via });
    }
  }

  return edges.sort(
    (a, b) =>
      a.consumer - b.consumer || a.producer - b.producer || a.channel.localeCompare(b.channel),
  );
}

/**
 * The channels a trace has edges on — a summary for a human, not a score.
 *
 * Deliberately not a number. A severity score would invite a threshold, a
 * threshold would become a gate, and a gate on a detector whose false-positive
 * rate is what this spike set out to measure is the wrong order to do things in.
 */
export function affectedChannels(edges: readonly CompositionEdge[]): readonly StateChannel[] {
  return [...new Set(edges.map((edge) => edge.channel))].sort();
}
