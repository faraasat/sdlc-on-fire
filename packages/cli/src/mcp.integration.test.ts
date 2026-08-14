import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkMcpCall, listMcpServers, MCP_REGISTRY, setMcpConsent } from './mcp.js';

/**
 * Teardown retries, because Windows keeps a file locked while anything holds it.
 *
 * A child process that has just exited can still own its handles for a moment,
 * and removing the directory then fails with EBUSY — which Vitest reports as a
 * failed suite even though every assertion in it passed. Retrying is the
 * documented remedy, and is a no-op on platforms without the problem.
 */
const RM_RETRY = { maxRetries: 5, retryDelay: 100 } as const;

/**
 * `sdlc mcp` against a real workspace (P2-MCP-01).
 *
 * The unit tests establish that the rules refuse. These establish the thing
 * only a file can: that consent is written down, that a decline survives, and
 * that re-consenting after drift shows the user what is newly being agreed to
 * rather than quietly accepting it.
 */

const dirs: string[] = [];

const registry = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    servers: [
      {
        id: 'supabase',
        provenance: 'https://github.com/supabase-community/supabase-mcp',
        consent: 'unconsented',
        tools: [
          { name: 'list_tables', description: 'Lists tables.', readOnlyHint: true },
          { name: 'apply_migration', description: 'Applies a migration.' },
        ],
        ...overrides,
      },
    ],
  });

async function workspace(contents = registry()): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sdlcof-mcp-'));
  dirs.push(root);
  await fs.writeFile(path.join(root, MCP_REGISTRY), contents, 'utf8');
  return root;
}

const read = async (root: string): Promise<{ servers: Record<string, unknown>[] }> =>
  JSON.parse(await fs.readFile(path.join(root, MCP_REGISTRY), 'utf8')) as {
    servers: Record<string, unknown>[];
  };

afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true, ...RM_RETRY })),
  );
});

describe('consent as a file', () => {
  it('treats an absent registry as nothing consented, not as an error', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sdlcof-mcp-'));
    dirs.push(root);
    const result = await listMcpServers(root);
    expect(result.servers).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('writes the pin at consent time', async () => {
    const root = await workspace();
    const result = await setMcpConsent(root, 'supabase', 'consented', {
      now: () => '2026-08-14T00:00:00Z',
    });
    expect(result.toolsPinned).toBe(2);

    const stored = (await read(root)).servers[0];
    expect(stored?.['consent']).toBe('consented');
    expect(stored?.['pinnedSchema']).toEqual(expect.any(String));
  });

  it('keeps a decline, with its reason', async () => {
    // Kept is what makes it revisable: the user can change their mind later and
    // the agent picks it up, which needs the earlier "no" to still exist.
    const root = await workspace();
    await setMcpConsent(root, 'supabase', 'declined', { reason: 'production database' });

    const stored = (await read(root)).servers[0];
    expect(stored?.['consent']).toBe('declined');
    expect(stored?.['declinedReason']).toBe('production database');
  });

  it('names an unknown server rather than silently consenting to nothing', async () => {
    const root = await workspace();
    await expect(setMcpConsent(root, 'stripe', 'consented')).rejects.toThrow(/no MCP server/);
  });
});

describe('drift', () => {
  it('reports a consented server whose tool set moved, and fails the listing', async () => {
    const root = await workspace();
    await setMcpConsent(root, 'supabase', 'consented');

    const stored = await read(root);
    (stored.servers[0]?.['tools'] as unknown[]).push({
      name: 'drop_table',
      description: 'Drops a table.',
    });
    await fs.writeFile(path.join(root, MCP_REGISTRY), JSON.stringify(stored), 'utf8');

    const result = await listMcpServers(root);
    expect(result.ok).toBe(false);
    expect(result.servers[0]?.drift.join(' ')).toContain('re-consent before use');
  });

  it('refuses a call against a drifted server', async () => {
    const root = await workspace();
    await setMcpConsent(root, 'supabase', 'consented');

    const stored = await read(root);
    (stored.servers[0]?.['tools'] as unknown[]).push({ name: 'drop_table', description: 'x' });
    await fs.writeFile(path.join(root, MCP_REGISTRY), JSON.stringify(stored), 'utf8');

    const result = await checkMcpCall(root, 'supabase', 'list_tables', 'read');
    expect(result.verdict.allowed).toBe(false);
  });

  it('shows what is newly being agreed to when re-consenting', async () => {
    // Re-consent is the only way to accept drift, and it is a deliberate act
    // with a diff attached rather than a check that quietly stops complaining.
    const root = await workspace();
    await setMcpConsent(root, 'supabase', 'consented');

    const stored = await read(root);
    (stored.servers[0]?.['tools'] as unknown[]).push({
      name: 'drop_table',
      description: 'Drops a table.',
    });
    await fs.writeFile(path.join(root, MCP_REGISTRY), JSON.stringify(stored), 'utf8');

    const again = await setMcpConsent(root, 'supabase', 'consented');
    expect(again.drift?.added).toEqual(['drop_table']);
  });

  it('reports no diff on a first consent rather than an empty one', async () => {
    // An empty diff reads as "nothing changed", which is a different claim from
    // "there was nothing to compare against".
    const root = await workspace();
    expect((await setMcpConsent(root, 'supabase', 'consented')).drift).toBeUndefined();
  });
});

describe('calls', () => {
  it('refuses every call before consent', async () => {
    const root = await workspace();
    expect((await checkMcpCall(root, 'supabase', 'list_tables', 'read')).verdict.allowed).toBe(
      false,
    );
  });

  it('still refuses a read the server merely claims is read-only', async () => {
    const root = await workspace();
    await setMcpConsent(root, 'supabase', 'consented');
    const result = await checkMcpCall(root, 'supabase', 'list_tables', 'read');
    expect(result.verdict.allowed).toBe(false);
    expect(result.verdict.reasons.join(' ')).toContain('a claim about itself');
  });

  it('allows a read once the project classified the tool', async () => {
    const root = await workspace(registry({ readOnlyAllowlist: ['list_tables'] }));
    await setMcpConsent(root, 'supabase', 'consented');
    expect((await checkMcpCall(root, 'supabase', 'list_tables', 'read')).verdict.allowed).toBe(
      true,
    );
  });

  it('allows a read under a server-enforced grant with no allowlist at all', async () => {
    const root = await workspace(registry({ serverEnforcedReadOnly: 'SELECT-only role' }));
    await setMcpConsent(root, 'supabase', 'consented');
    expect((await checkMcpCall(root, 'supabase', 'list_tables', 'read')).verdict.allowed).toBe(
      true,
    );
  });

  it('refuses a write regardless of consent and classification', async () => {
    const root = await workspace(registry({ serverEnforcedReadOnly: 'SELECT-only role' }));
    await setMcpConsent(root, 'supabase', 'consented');
    const result = await checkMcpCall(root, 'supabase', 'apply_migration', 'write');
    expect(result.verdict.allowed).toBe(false);
    expect(result.verdict.reasons.join(' ')).toContain('a person approves it');
  });
});
