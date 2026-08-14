import fs from 'node:fs/promises';
import path from 'node:path';
import {
  classifyTool,
  diffSchema,
  evaluateMcpCall,
  pinSchema,
  relativePosix,
  resolveWorkspaceLayout,
  type CallVerdict,
  type ConsentState,
  type McpServerRecord,
  type McpToolDescriptor,
  type ToolClassification,
} from '@sdlc-on-fire/core';

/**
 * `sdlc mcp` — consuming external MCP servers (P2-MCP-01, ADR-0058).
 *
 * Consent is a **file in the workspace**, not a row in a database and not a
 * flag on a command. Three reasons, and they are the design rather than a
 * storage preference:
 *
 * - It shows up in a diff. "We started letting the agent talk to the production
 *   database" should be a reviewable change, not a state transition nobody sees.
 * - It survives `db:rebuild`, like every other piece of content.
 * - A decline is recorded rather than forgotten, which is what makes it
 *   *revisable* — ADR-0058 wants the user able to change their mind later and
 *   the agent to pick it up, and that needs the earlier "no" to still exist.
 *
 * The pin goes in at consent time, from the tool list as it stood then. That is
 * the whole mechanism behind "consent is to a tool list, not to a server".
 */

export const MCP_REGISTRY = 'mcp-servers.json';

interface StoredServer {
  readonly id: string;
  readonly provenance: string;
  readonly consent: ConsentState;
  readonly consentedAt?: string;
  readonly declinedReason?: string;
  readonly pinnedSchema?: string;
  /**
   * The tool list as it stood at consent time.
   *
   * Stored alongside the hash rather than instead of it. The hash answers
   * "has anything changed"; only the list answers "what", and a drift warning
   * nobody can act on gets dismissed rather than investigated.
   */
  readonly pinnedTools?: readonly McpToolDescriptor[];
  readonly serverEnforcedReadOnly?: string;
  readonly readOnlyAllowlist?: readonly string[];
  readonly tools: readonly McpToolDescriptor[];
}

const registryPath = (root: string): string =>
  path.join(resolveWorkspaceLayout(root).root, MCP_REGISTRY);

async function readRegistry(root: string): Promise<StoredServer[]> {
  const raw = await fs.readFile(registryPath(root), 'utf8').catch(() => null);
  if (raw === null) return [];
  const parsed = JSON.parse(raw) as { servers?: StoredServer[] };
  return parsed.servers ?? [];
}

async function writeRegistry(root: string, servers: readonly StoredServer[]): Promise<void> {
  await fs.writeFile(
    registryPath(root),
    `${JSON.stringify({ servers: [...servers].sort((a, b) => a.id.localeCompare(b.id)) }, null, 2)}\n`,
    'utf8',
  );
}

const toRecord = (stored: StoredServer): McpServerRecord => ({
  id: stored.id,
  provenance: stored.provenance,
  consent: stored.consent,
  ...(stored.pinnedSchema === undefined ? {} : { pinnedSchema: stored.pinnedSchema }),
  ...(stored.serverEnforcedReadOnly === undefined
    ? {}
    : { serverEnforcedReadOnly: stored.serverEnforcedReadOnly }),
  tools: stored.tools,
});

export interface McpListEntry {
  readonly id: string;
  readonly consent: ConsentState;
  readonly provenance: string;
  readonly classifications: readonly ToolClassification[];
  /** Populated when the server's current tool set no longer matches the pin. */
  readonly drift: readonly string[];
}

export interface McpListResult {
  readonly registry: string;
  readonly servers: readonly McpListEntry[];
  readonly ok: boolean;
}

export async function listMcpServers(root: string): Promise<McpListResult> {
  const stored = await readRegistry(root);
  const servers = stored.map((entry) => {
    const record = toRecord(entry);
    const classifications = entry.tools.map((tool) =>
      classifyTool(tool, record, entry.readOnlyAllowlist ?? []),
    );

    // Drift is computed against the pin, so a consented server whose listing
    // changed shows up here rather than at the moment of the first call.
    const drift: string[] = [];
    if (entry.pinnedSchema !== undefined && pinSchema(entry.tools) !== entry.pinnedSchema) {
      drift.push(
        'tool set no longer matches the pin taken at consent time — re-consent before use',
      );
    }

    return {
      id: entry.id,
      consent: entry.consent,
      provenance: entry.provenance,
      classifications,
      drift,
    };
  });

  return {
    registry: relativePosix(resolveWorkspaceLayout(root).root, registryPath(root)),
    servers,
    ok: servers.every((entry) => entry.drift.length === 0),
  };
}

export interface ConsentResult {
  readonly id: string;
  readonly consent: ConsentState;
  readonly pinnedSchema?: string | undefined;
  readonly toolsPinned: number;
  readonly drift?: ReturnType<typeof diffSchema> | undefined;
}

/**
 * Records a consent decision.
 *
 * Consenting **re-pins**, which is the only way to accept a drifted server —
 * and it is a deliberate act with a diff attached, rather than a check that
 * quietly stops complaining. The previous tool list is diffed into the result
 * so whoever runs this sees what they are agreeing to that they had not before.
 */
export async function setMcpConsent(
  root: string,
  id: string,
  consent: ConsentState,
  options: { readonly reason?: string | undefined; readonly now?: (() => string) | undefined } = {},
): Promise<ConsentResult> {
  const servers = await readRegistry(root);
  const index = servers.findIndex((entry) => entry.id === id);
  if (index === -1) throw new Error(`no MCP server "${id}" in ${MCP_REGISTRY}`);

  const before = servers[index] as StoredServer;
  const now = options.now ?? (() => new Date().toISOString());

  // Against the previous pin, so re-consenting shows exactly what is newly
  // being agreed to. Undefined on a first consent: there was nothing to differ
  // from, and reporting an empty diff would read as "nothing changed".
  const drift =
    before.pinnedTools === undefined ? undefined : diffSchema(before.pinnedTools, before.tools);

  const next: StoredServer =
    consent === 'consented'
      ? {
          ...before,
          consent,
          consentedAt: now(),
          pinnedSchema: pinSchema(before.tools),
          pinnedTools: before.tools,
        }
      : {
          ...before,
          consent,
          ...(options.reason === undefined ? {} : { declinedReason: options.reason }),
        };

  servers[index] = next;
  await writeRegistry(root, servers);

  return {
    id,
    consent,
    ...(next.pinnedSchema === undefined ? {} : { pinnedSchema: next.pinnedSchema }),
    toolsPinned: consent === 'consented' ? before.tools.length : 0,
    ...(drift === undefined ? {} : { drift }),
  };
}

export interface McpCheckResult {
  readonly server: string;
  readonly tool: string;
  readonly intent: 'read' | 'write';
  readonly verdict: CallVerdict;
}

/** Whether one call would be permitted, without making it. */
export async function checkMcpCall(
  root: string,
  id: string,
  toolName: string,
  intent: 'read' | 'write',
): Promise<McpCheckResult> {
  const servers = await readRegistry(root);
  const stored = servers.find((entry) => entry.id === id);
  if (stored === undefined) throw new Error(`no MCP server "${id}" in ${MCP_REGISTRY}`);

  return {
    server: id,
    tool: toolName,
    intent,
    verdict: evaluateMcpCall({
      server: toRecord(stored),
      tool: toolName,
      intent,
      allowlist: stored.readOnlyAllowlist ?? [],
      currentTools: stored.tools,
    }),
  };
}

export function formatMcpList(result: McpListResult): string {
  if (result.servers.length === 0) {
    return `no ${MCP_REGISTRY} — nothing is consented, which is the default and not a problem.`;
  }

  const lines: string[] = [];
  for (const server of result.servers) {
    lines.push(`${server.id}  [${server.consent}]  ${server.provenance}`);
    for (const classification of server.classifications) {
      const mark = classification.access === 'read-only' ? '✓' : '·';
      lines.push(
        `  ${mark} ${classification.tool.padEnd(22)} ${classification.access} (${classification.source})`,
      );
    }
    for (const drift of server.drift) lines.push(`  ✗ ${drift}`);
    lines.push('');
  }

  lines.push(
    'Anything not classified read-only needs a person to approve each call. An',
    "annotation is the server's claim about itself and never licenses on its own.",
  );
  return lines.join('\n');
}
