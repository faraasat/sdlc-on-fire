/**
 * Consuming someone else's MCP server (P2-MCP-01, ADR-0058).
 *
 * The mirror image of [ADR-0024]'s compile target. There we *emit* an MCP
 * server from our own reviewed skills; here we *call* servers somebody else
 * wrote, against the user's real stack, and every assumption reverses. Our
 * compiled tools are `first-party-reviewed` by construction. These are not
 * reviewed by anyone, and the failure mode is not a bug — it is a tool that
 * does more than its own description says.
 *
 * ADR-0058 names the specific mechanism, and it is the reason this module
 * refuses to read tool metadata as a permission:
 *
 * **`readOnlyHint` is a claim by the server about itself.** Tool listings drift
 * from actual privilege — the ADR cites Supabase MCP #281, where the listing
 * and the grant disagreed. A client that reads `readOnlyHint: true` and calls
 * the tool has verified nothing; it has read a sentence the server wrote about
 * a tool the same server implements. The MCP spec agrees, in its own words:
 * clients MUST treat tool annotations as untrusted unless the server is
 * trusted.
 *
 * So classification runs in a strict order, and **an annotation never licenses
 * on its own**:
 *
 * 1. **Server-enforced** — a restricted DB role, `--read-only` mode, a
 *    read-scoped key. Evidence about the *grant*, not about the listing, and
 *    the only thing that actually constrains what a call can do.
 * 2. **A first-party allowlist** — a tool we have classified ourselves.
 * 3. **Everything else is `unknown`, and unknown is not read-only.**
 *    Conservative on purpose: this blocks benign tools until somebody
 *    classifies them, and the ADR accepts that cost explicitly.
 *
 * Three more rules, each closing a way the consent means less than it looks:
 *
 * **Consent is to a specific tool list, not to a server.** The tool set is
 * hashed when consent is given, and a later change is drift requiring
 * re-consent. Without it, "yes, install the GitHub MCP" is consent to whatever
 * that server exposes next month.
 *
 * **A write is never executed on the agent's own authority** — a human approves
 * it, checked by `actorKind`, the same device as every other approval boundary
 * in this codebase.
 *
 * **MCP output is data, not instructions**, and it is scanned before it enters
 * context or evidence. A tool result that reads like a directive is a tool
 * result, and one carrying a live credential is not put into a transcript.
 */

import { createHash } from 'node:crypto';
import { scanForSecrets } from './secret-scan.js';

export const CONSENT_STATES = ['unconsented', 'consented', 'declined'] as const;
export type ConsentState = (typeof CONSENT_STATES)[number];

/** How a tool's access level was established. Ordered by how much it is worth. */
export const CLASSIFICATION_SOURCES = [
  'server-enforced',
  'allowlist',
  'annotation',
  'none',
] as const;
export type ClassificationSource = (typeof CLASSIFICATION_SOURCES)[number];

export type AccessLevel = 'read-only' | 'write' | 'unknown';

export interface McpToolDescriptor {
  readonly name: string;
  readonly description: string;
  /** The server's own claim. Recorded, never trusted on its own. */
  readonly readOnlyHint?: boolean | undefined;
}

export interface McpServerRecord {
  readonly id: string;
  /** Where it came from — checked before install (ADR-0033 supply chain). */
  readonly provenance: string;
  readonly consent: ConsentState;
  /** The tool-set hash recorded when consent was given. */
  readonly pinnedSchema?: string | undefined;
  /**
   * Evidence that the *grant* is read-only — a restricted role, `--read-only`,
   * a read-scoped key. A sentence about the server's configuration, supplied by
   * the person who configured it, not by the server.
   */
  readonly serverEnforcedReadOnly?: string | undefined;
  readonly tools: readonly McpToolDescriptor[];
}

export interface ToolClassification {
  readonly tool: string;
  readonly access: AccessLevel;
  readonly source: ClassificationSource;
  readonly because: string;
}

/**
 * Classifies one tool's access level.
 *
 * `allowlist` is the set of tool names *we* have classified as read-only. The
 * server's `readOnlyHint` is recorded in `because` when it disagrees, because a
 * server claiming read-only for a tool nobody has classified is exactly the
 * case worth being able to find later.
 */
export function classifyTool(
  tool: McpToolDescriptor,
  server: Pick<McpServerRecord, 'serverEnforcedReadOnly'>,
  allowlist: readonly string[] = [],
): ToolClassification {
  if (server.serverEnforcedReadOnly !== undefined && server.serverEnforcedReadOnly !== '') {
    return {
      tool: tool.name,
      access: 'read-only',
      source: 'server-enforced',
      because: `the grant itself is read-only: ${server.serverEnforcedReadOnly}`,
    };
  }

  if (allowlist.includes(tool.name)) {
    return {
      tool: tool.name,
      access: 'read-only',
      source: 'allowlist',
      because: 'classified read-only by this project',
    };
  }

  return {
    tool: tool.name,
    access: 'unknown',
    source: 'none',
    because:
      tool.readOnlyHint === true
        ? 'the server calls this read-only, which is a claim about itself — tool listings drift ' +
          'from actual privilege, so an unclassified tool stays unknown (ADR-0058)'
        : 'not classified, and unknown is not read-only',
  };
}

/**
 * A stable fingerprint of what a server exposes.
 *
 * Names and descriptions both, because a tool that keeps its name and changes
 * what it says it does is the more interesting drift: the call site is
 * unchanged and the meaning is not.
 */
export function pinSchema(tools: readonly McpToolDescriptor[]): string {
  const canonical = [...tools]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((tool) => `${tool.name} ${tool.description}`)
    .join('');
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export interface SchemaDrift {
  readonly drifted: boolean;
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly redescribed: readonly string[];
}

/** What changed since consent was given. */
export function diffSchema(
  pinned: readonly McpToolDescriptor[],
  current: readonly McpToolDescriptor[],
): SchemaDrift {
  const before = new Map(pinned.map((tool) => [tool.name, tool.description]));
  const after = new Map(current.map((tool) => [tool.name, tool.description]));

  const added = [...after.keys()].filter((name) => !before.has(name)).sort();
  const removed = [...before.keys()].filter((name) => !after.has(name)).sort();
  const redescribed = [...after.entries()]
    .filter(([name, description]) => before.has(name) && before.get(name) !== description)
    .map(([name]) => name)
    .sort();

  return {
    drifted: added.length > 0 || removed.length > 0 || redescribed.length > 0,
    added,
    removed,
    redescribed,
  };
}

export interface CallApproval {
  readonly actorId: string;
  readonly actorKind: 'human' | 'agent';
  readonly at: string;
}

export interface CallVerdict {
  readonly allowed: boolean;
  readonly reasons: readonly string[];
}

/**
 * Whether one MCP call may proceed.
 *
 * `intent` is what the *caller* says it is doing, and it is deliberately not
 * trusted to make a write safe: a call declared `read` against a tool nobody
 * classified is still refused. It exists so a caller cannot accidentally
 * perform a write while believing it read — declaring `write` is what unlocks
 * the approval path, never what bypasses it.
 */
export function evaluateMcpCall(input: {
  readonly server: McpServerRecord;
  readonly tool: string;
  readonly intent: 'read' | 'write';
  readonly allowlist?: readonly string[] | undefined;
  readonly approvals?: readonly CallApproval[] | undefined;
  /** The tool list as the server reports it *now*, for the drift check. */
  readonly currentTools?: readonly McpToolDescriptor[] | undefined;
}): CallVerdict {
  const reasons: string[] = [];
  const { server } = input;

  if (server.consent !== 'consented') {
    return {
      allowed: false,
      reasons: [
        server.consent === 'declined'
          ? `${server.id} was declined — recorded and revisable, but not usable until the user changes their mind (ADR-0058)`
          : `${server.id} has not been consented to — no MCP is enabled without the user saying so`,
      ],
    };
  }

  const current = input.currentTools;
  if (current !== undefined && server.pinnedSchema !== undefined) {
    const now = pinSchema(current);
    if (now !== server.pinnedSchema) {
      // Consent was to a tool list, not to a server. Otherwise "yes, install
      // it" is consent to whatever that server exposes next month.
      return {
        allowed: false,
        reasons: [
          `${server.id}'s tool set has changed since consent was given — re-consent before use ` +
            '(schema pin-and-diff, ADR-0058)',
        ],
      };
    }
  }

  const descriptor = server.tools.find((tool) => tool.name === input.tool);
  if (descriptor === undefined) {
    return { allowed: false, reasons: [`${server.id} exposes no tool named "${input.tool}"`] };
  }

  const classification = classifyTool(descriptor, server, input.allowlist ?? []);

  if (input.intent === 'write') {
    const human = (input.approvals ?? []).find((approval) => approval.actorKind === 'human');
    if (human === undefined) {
      return {
        allowed: false,
        reasons: [
          `"${input.tool}" was called as a write — the agent never executes a destructive or ` +
            'writing MCP operation on its own authority. It may propose one; a person approves it.',
        ],
      };
    }
    return {
      allowed: true,
      reasons: [`write approved by ${human.actorId} at ${human.at}`],
    };
  }

  if (classification.access !== 'read-only') {
    return {
      allowed: false,
      reasons: [`"${input.tool}" is ${classification.access}: ${classification.because}`],
    };
  }

  reasons.push(
    `"${input.tool}" is read-only (${classification.source}): ${classification.because}`,
  );
  return { allowed: true, reasons };
}

export interface RedactedResult {
  readonly text: string;
  readonly redactions: number;
  /** Rules that fired, so an over-redaction can be argued with. */
  readonly rules: readonly string[];
}

/** What replaces a confidential-looking value. */
export const MCP_REDACTION = '[redacted:mcp-read]';

/**
 * Obfuscates confidential values in an MCP result before it enters context.
 *
 * Line-scoped, and it replaces the whole line rather than the matched span. A
 * span-precise redaction leaves the surrounding structure — the key name, the
 * prefix, the length — and those are frequently enough to identify or
 * reconstruct the value. The cost is losing a line of otherwise-useful output,
 * which is the right trade for data being copied into a transcript that will
 * outlive the run.
 *
 * Never claimed perfect: novel formats are missed and benign values are
 * sometimes caught. ADR-0058 says so, and saying so is the honest version —
 * this reduces exposure, it does not make an MCP read safe to paste anywhere.
 */
export function redactMcpResult(text: string): RedactedResult {
  const findings = scanForSecrets(text);
  if (findings.length === 0) return { text, redactions: 0, rules: [] };

  const drop = new Set(findings.map((finding) => finding.line));
  const lines = text
    .split(/\r?\n/)
    .map((line, index) => (drop.has(index + 1) ? MCP_REDACTION : line));

  return {
    text: lines.join('\n'),
    redactions: drop.size,
    rules: [...new Set(findings.map((finding) => finding.rule))].sort(),
  };
}

export function formatCallVerdict(server: string, tool: string, verdict: CallVerdict): string {
  return [
    `${verdict.allowed ? '✓' : '✗'} ${server}/${tool}`,
    ...verdict.reasons.map((reason) => `    ${reason}`),
  ].join('\n');
}
