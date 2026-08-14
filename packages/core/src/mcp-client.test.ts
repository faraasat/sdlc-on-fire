import { describe, expect, it } from 'vitest';
import {
  classifyTool,
  diffSchema,
  evaluateMcpCall,
  MCP_REDACTION,
  pinSchema,
  redactMcpResult,
  type CallApproval,
  type McpServerRecord,
  type McpToolDescriptor,
} from './mcp-client.js';

/**
 * P2-MCP-01 — calling a server somebody else wrote.
 *
 * Every case here is a way an MCP client ends up doing more than it was
 * permitted to while every visible signal says otherwise: the tool said it was
 * read-only, the user did consent, the call declared itself a read.
 */

const tool = (overrides: Partial<McpToolDescriptor> = {}): McpToolDescriptor => ({
  name: 'list_tables',
  description: 'Lists the tables in the database.',
  ...overrides,
});

const server = (overrides: Partial<McpServerRecord> = {}): McpServerRecord => ({
  id: 'supabase',
  provenance: 'https://github.com/supabase-community/supabase-mcp',
  consent: 'consented',
  tools: [tool(), tool({ name: 'apply_migration', description: 'Applies a migration.' })],
  ...overrides,
});

const human: CallApproval = { actorId: 'founder', actorKind: 'human', at: '2026-08-14T00:00:00Z' };
const agent: CallApproval = { actorId: 'bot', actorKind: 'agent', at: '2026-08-14T00:00:00Z' };

describe('classifyTool', () => {
  it('does not treat readOnlyHint as a classification', () => {
    // The mechanism ADR-0058 cites: a tool listing can drift from the actual
    // grant. `readOnlyHint: true` is a sentence the server wrote about a tool
    // the same server implements.
    const classification = classifyTool(tool({ readOnlyHint: true }), {});
    expect(classification.access).toBe('unknown');
    expect(classification.because).toContain('a claim about itself');
  });

  it('accepts a server-enforced read-only grant', () => {
    const classification = classifyTool(tool({ readOnlyHint: false }), {
      serverEnforcedReadOnly: 'connected as a role with SELECT only',
    });
    expect(classification.access).toBe('read-only');
    expect(classification.source).toBe('server-enforced');
  });

  it('accepts a tool this project classified itself', () => {
    expect(classifyTool(tool(), {}, ['list_tables']).source).toBe('allowlist');
  });

  it('leaves anything else unknown, and unknown is not read-only', () => {
    // Conservative on purpose — this blocks benign tools until someone
    // classifies them, and ADR-0058 accepts that cost explicitly.
    expect(classifyTool(tool({ name: 'mystery' }), {}).access).toBe('unknown');
  });

  it('ignores an empty server-enforcement string rather than reading it as evidence', () => {
    expect(classifyTool(tool(), { serverEnforcedReadOnly: '' }).access).toBe('unknown');
  });
});

describe('consent', () => {
  it('refuses a server nobody consented to', () => {
    const verdict = evaluateMcpCall({
      server: server({ consent: 'unconsented' }),
      tool: 'list_tables',
      intent: 'read',
      allowlist: ['list_tables'],
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reasons.join(' ')).toContain('no MCP is enabled without the user saying so');
  });

  it('refuses a declined server, and says the decision is revisable', () => {
    const verdict = evaluateMcpCall({
      server: server({ consent: 'declined' }),
      tool: 'list_tables',
      intent: 'read',
      allowlist: ['list_tables'],
    });
    expect(verdict.reasons.join(' ')).toContain('revisable');
  });
});

describe('schema pin-and-diff', () => {
  it('refuses a server whose tool set changed since consent', () => {
    // Consent was to a tool list. Without the pin, "yes, install it" is consent
    // to whatever that server exposes next month.
    const pinned = server({ pinnedSchema: pinSchema(server().tools) });
    const verdict = evaluateMcpCall({
      server: pinned,
      tool: 'list_tables',
      intent: 'read',
      allowlist: ['list_tables'],
      currentTools: [...pinned.tools, tool({ name: 'drop_table', description: 'Drops a table.' })],
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reasons.join(' ')).toContain('re-consent before use');
  });

  it('allows an unchanged tool set', () => {
    const pinned = server({ pinnedSchema: pinSchema(server().tools) });
    expect(
      evaluateMcpCall({
        server: pinned,
        tool: 'list_tables',
        intent: 'read',
        allowlist: ['list_tables'],
        currentTools: pinned.tools,
      }).allowed,
    ).toBe(true);
  });

  it('changes when only a description changed', () => {
    // The pin is what the *call* gate compares, so a description-only change
    // that the hash ignores walks straight past it — and a tool that keeps its
    // name while changing what it claims to do is the drift worth catching.
    expect(pinSchema([tool({ description: 'Lists tables.' })])).not.toBe(
      pinSchema([tool({ description: 'Lists tables and deletes empty ones.' })]),
    );
  });

  it('refuses a call after a description-only change', () => {
    const pinned = server({ pinnedSchema: pinSchema(server().tools) });
    const verdict = evaluateMcpCall({
      server: pinned,
      tool: 'list_tables',
      intent: 'read',
      allowlist: ['list_tables'],
      currentTools: [
        tool({ description: 'Lists tables, and drops the empty ones.' }),
        ...pinned.tools.slice(1),
      ],
    });
    expect(verdict.allowed).toBe(false);
  });

  it('hashes independently of tool order', () => {
    const [a, b] = server().tools;
    expect(pinSchema([a as McpToolDescriptor, b as McpToolDescriptor])).toBe(
      pinSchema([b as McpToolDescriptor, a as McpToolDescriptor]),
    );
  });

  it('notices a tool that kept its name and changed what it claims to do', () => {
    // The more interesting drift: the call site is unchanged and the meaning is
    // not, so a name-only comparison sees nothing.
    const drift = diffSchema(
      [tool({ description: 'Lists tables.' })],
      [tool({ description: 'Lists tables and deletes empty ones.' })],
    );
    expect(drift.drifted).toBe(true);
    expect(drift.redescribed).toEqual(['list_tables']);
  });

  it('separates added, removed and redescribed', () => {
    const drift = diffSchema(
      [tool(), tool({ name: 'gone', description: 'x' })],
      [tool(), tool({ name: 'new', description: 'y' })],
    );
    expect(drift.added).toEqual(['new']);
    expect(drift.removed).toEqual(['gone']);
  });
});

describe('writes', () => {
  it('refuses a write with no human approval', () => {
    const verdict = evaluateMcpCall({
      server: server(),
      tool: 'apply_migration',
      intent: 'write',
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reasons.join(' ')).toContain('may propose one; a person approves it');
  });

  it('refuses a write approved only by an agent', () => {
    expect(
      evaluateMcpCall({
        server: server(),
        tool: 'apply_migration',
        intent: 'write',
        approvals: [agent],
      }).allowed,
    ).toBe(false);
  });

  it('allows a write a person approved', () => {
    const verdict = evaluateMcpCall({
      server: server(),
      tool: 'apply_migration',
      intent: 'write',
      approvals: [human],
    });
    expect(verdict.allowed).toBe(true);
    expect(verdict.reasons.join(' ')).toContain('approved by founder');
  });

  it('does not let a `read` intent turn an unclassified tool into a safe one', () => {
    // Declaring `write` unlocks the approval path; declaring `read` never
    // bypasses classification.
    expect(
      evaluateMcpCall({ server: server(), tool: 'apply_migration', intent: 'read' }).allowed,
    ).toBe(false);
  });
});

describe('the tool itself', () => {
  it('refuses a tool the server does not expose', () => {
    const verdict = evaluateMcpCall({ server: server(), tool: 'nope', intent: 'read' });
    expect(verdict.reasons.join(' ')).toContain('exposes no tool named');
  });

  it('allows a read against a server-enforced read-only grant', () => {
    const verdict = evaluateMcpCall({
      server: server({ serverEnforcedReadOnly: 'SELECT-only role' }),
      tool: 'list_tables',
      intent: 'read',
    });
    expect(verdict.allowed).toBe(true);
    expect(verdict.reasons.join(' ')).toContain('server-enforced');
  });
});

describe('redactMcpResult', () => {
  it('replaces the whole line, not the matched span', () => {
    // A span-precise redaction leaves the key name, the prefix and the length —
    // frequently enough to identify or reconstruct the value.
    const result = redactMcpResult('user: alice\naws_key = AKIAIOSFODNN7EXAMPLE\n');
    expect(result.text).toContain(MCP_REDACTION);
    expect(result.text).not.toContain('aws_key');
    expect(result.text).toContain('user: alice');
  });

  it('reports how much it removed and which rules fired', () => {
    // So an over-redaction can be argued with rather than silently endured.
    const result = redactMcpResult('AKIAIOSFODNN7EXAMPLE\n');
    expect(result.redactions).toBe(1);
    expect(result.rules.length).toBeGreaterThan(0);
  });

  it('leaves clean output untouched', () => {
    const text = 'id | name\n1  | alice\n';
    expect(redactMcpResult(text)).toEqual({ text, redactions: 0, rules: [] });
  });

  it('handles CRLF, which is what a Windows-hosted server returns', () => {
    const result = redactMcpResult('a\r\nAKIAIOSFODNN7EXAMPLE\r\nb\r\n');
    expect(result.redactions).toBe(1);
    expect(result.text.split('\n')[1]).toBe(MCP_REDACTION);
  });
});
