import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CanonicalSkillSchema, type CanonicalSkill } from '@sdlc-on-fire/core';
import { afterEach, describe, expect, it } from 'vitest';
import { missingCapabilityRows } from '../port.js';
import {
  lintMcpTool,
  mcpCapabilities,
  mcpInputSchema,
  mcpToolDescription,
  mcpToolName,
  McpAdapter,
  MCP_COVERS_ALL_FIELDS,
  MCP_META_PREFIX,
  MCP_PROTOCOL_VERSION,
  type McpServerDocument,
  type McpTool,
} from './mcp.js';

/**
 * The MCP target (P2-AGT-01, contract 04 §4.3).
 *
 * What is under test is not "does it emit JSON" — it is the handful of ways a
 * compiled protocol artifact is accepted by a client and then unusable: a name
 * outside the spec's character set, an `inputSchema` that is absent or `{}`, a
 * capability the document does not back, and a security boundary compiled into
 * a field clients are told to distrust.
 */

function skill(overrides: Record<string, unknown> = {}): CanonicalSkill {
  return CanonicalSkillSchema.parse({
    schema_version: '0.1.0',
    name: 'implement',
    description: 'Implement one scoped task and report what changed.',
    stage: 'implement',
    tier: 'medium',
    context_pack_spec_ref: 'context-packs/implement.yaml',
    role: 'You are the Implementer agent.',
    constitution_excerpt_ref: 'constitution#engineering',
    task: 'Implement {{work_item_id}} against its acceptance criteria.',
    arguments: [{ name: 'work-item-id', required: true, description: 'The card to implement.' }],
    output_contract: {
      tool_name: 'implement_output',
      json_schema_ref: 'schemas/implement-output.schema.json',
    },
    self_verification: 'Never report that tests passed — the daemon runs them.',
    stop_condition: 'Stop after one report.',
    verify: { command_template: 'pnpm test', done_criteria_ref: 'task#done' },
    ...overrides,
  });
}

const adapter = new McpAdapter('0.1.0');
const tempDirs: string[] = [];

const serverDocument = (skills: readonly CanonicalSkill[]): McpServerDocument =>
  JSON.parse(adapter.compileServer(skills).files[0]?.content ?? '{}') as McpServerDocument;

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('capability totality', () => {
  it('accounts for every canonical field', () => {
    expect(MCP_COVERS_ALL_FIELDS).toBe(true);
    expect(missingCapabilityRows(adapter)).toEqual([]);
  });
});

describe('tool names', () => {
  it('service-prefixes, per the ADR-0024 namespacing rule', () => {
    expect(mcpToolName(skill())).toBe('sdlc__implement');
  });

  it('refuses a name the spec would not allow', () => {
    // Checked rather than assumed. A name outside `[A-Za-z0-9_.-]` produces a
    // tool the server lists and the client rejects — an entry that exists and
    // never works, which is indistinguishable from a working one until called.
    const long = 'a'.repeat(130);
    expect(() => mcpToolName(skill({ name: long }))).toThrow(/not a legal tool name/);
  });

  it('refuses two skills that would compile to one tool', () => {
    expect(() => adapter.compileServer([skill(), skill()])).toThrow(/duplicate tool name/);
  });
});

describe('inputSchema', () => {
  it('is a JSON Schema object even when the skill takes nothing', () => {
    // The spec: `inputSchema` MUST be a valid JSON Schema object, never null.
    // `{}` would accept anything; the spec's own answer for "no parameters" is
    // an object that accepts only an empty one.
    const schema = mcpInputSchema(skill({ task: 'Do the thing.', arguments: undefined }));
    expect(schema).toEqual({ type: 'object', additionalProperties: false });
  });

  it('marks a required argument required', () => {
    // From the canonical flag. A schema that marks a required argument optional
    // lets the model call the tool without it, and the skill then runs on a
    // blank it was promised — the same defect the slot rule below closes,
    // arriving through the other door.
    expect(mcpInputSchema(skill())).toMatchObject({ required: ['work-item-id'] });
  });

  it('omits `required` entirely when nothing is required', () => {
    const schema = mcpInputSchema(
      skill({
        task: 'Do the thing.',
        arguments: [{ name: 'note', required: false }],
      }),
    );
    expect(schema).not.toHaveProperty('required');
    expect(schema).toMatchObject({ properties: { note: { type: 'string' } } });
  });

  it('carries each argument description into its property', () => {
    expect(mcpInputSchema(skill())).toMatchObject({
      properties: { 'work-item-id': { description: 'The card to implement.' } },
    });
  });
});

describe('the description', () => {
  it('folds in the role, stop condition and self-verification', () => {
    // MCP has nowhere else to put them: the client writes its own system prompt
    // around the call, so anything not in the description is not said.
    const text = mcpToolDescription(skill());
    expect(text).toContain('You are the Implementer agent.');
    expect(text).toContain('Stop after one report.');
    expect(text).toContain('Never report that tests passed');
  });

  it('renders a slot as the input property that fills it', () => {
    expect(mcpToolDescription(skill())).toContain('<work-item-id>');
    expect(mcpToolDescription(skill())).not.toContain('{{');
  });

  it('refuses a slot with no declared argument', () => {
    // The same rule the Claude Code adapter enforces. A blank in an agent's
    // instructions is answered anyway, and an MCP tool's only channel for
    // filling one is `inputSchema`.
    expect(() =>
      mcpToolDescription(skill({ task: 'Implement {{mystery}}.', arguments: [] })),
    ).toThrow(/has no declared argument to bind to/);
  });
});

describe('capabilities', () => {
  it('declares tools when tools were emitted', () => {
    expect(serverDocument([skill()]).capabilities).toEqual({ tools: { listChanged: false } });
  });

  it('declares nothing when nothing was emitted', () => {
    // A capability is a promise to a client, not a description of ambition.
    expect(mcpCapabilities([])).toEqual({});
  });

  it('never claims a primitive the document does not publish', () => {
    // Derived, not written down — so there is no literal block to drift. A
    // declared `resources` with none published makes a client call
    // `resources/list` and get an error.
    const document = serverDocument([skill()]);
    expect(document.capabilities).not.toHaveProperty('resources');
    expect(document.capabilities).not.toHaveProperty('prompts');
  });
});

describe('scoping and trust', () => {
  const scoped = skill({ allowed_tools: ['Read', 'Edit'], disallowed_tools: ['Bash'] });

  it('keeps tool scoping out of `annotations`', () => {
    // The spec instructs clients to treat annotations as untrusted unless the
    // server is trusted, which makes them hints a client may ignore.
    // Compiling a deny-list there turns an enforcement into a suggestion, and
    // it would look exactly as correct as this does.
    const [tool] = serverDocument([scoped]).tools;
    expect(tool).not.toHaveProperty('annotations');
    expect(tool?._meta[`${MCP_META_PREFIX}scopes`]).toEqual({
      allowed: ['Read', 'Edit'],
      disallowed: ['Bash'],
    });
  });

  it('tags every compiled tool first-party-reviewed', () => {
    const [tool] = serverDocument([skill()]).tools;
    expect(tool?._meta[`${MCP_META_PREFIX}trust`]).toBe('first-party-reviewed');
  });

  it('uses a `_meta` prefix the spec has not reserved', () => {
    // Reserved: any prefix whose second label is `modelcontextprotocol` or
    // `mcp`. A reserved key is one a client is entitled to reinterpret.
    const [, second] = MCP_META_PREFIX.replace('/', '').split('.');
    expect(second).not.toBe('mcp');
    expect(second).not.toBe('modelcontextprotocol');
  });
});

describe('the server document', () => {
  it('names the spec revision it was compiled against', () => {
    expect(serverDocument([skill()]).protocolVersion).toBe(MCP_PROTOCOL_VERSION);
  });

  it('reuses the output contract rather than re-authoring it', () => {
    // One Zod-derived schema, two consuming surfaces: the prompt's output
    // contract and the MCP tool's result contract.
    const [tool] = serverDocument([skill()]).tools;
    expect(tool?.outputSchema).toMatchObject({ type: 'object' });
  });

  it('refuses a skill whose output contract resolves to nothing', () => {
    // Not an omitted field: a tool with no `outputSchema` and one whose schema
    // failed to load are indistinguishable to a client, and the second is a
    // contract that silently stopped being enforced.
    expect(() =>
      adapter.compileServer([
        skill({
          output_contract: { tool_name: 'x_output', json_schema_ref: 'schemas/nope.json' },
        }),
      ]),
    ).toThrow(/resolves to nothing/);
  });

  it('is deterministic and order-independent', () => {
    // Contract §3 points 1 and 4. Directory read order is not stable across
    // platforms, so an idempotency check that passes on the author's machine is
    // not one.
    const spec = skill({
      name: 'spec',
      stage: 'spec',
      task: 'Write a spec.',
      arguments: [],
      output_contract: {
        tool_name: 'spec_output',
        json_schema_ref: 'schemas/spec-output.schema.json',
      },
    });
    const forward = adapter.compileServer([skill(), spec]).files[0]?.content;
    const backward = adapter.compileServer([spec, skill()]).files[0]?.content;
    expect(forward).toBe(backward);
  });

  it('emits one document, not one file per skill', () => {
    const result = adapter.compileServer([skill()]);
    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.path).toBe('.mcp/sdlc-on-fire.json');
  });
});

describe('the house-rule lint', () => {
  const tool = (overrides: Partial<McpTool>): McpTool => ({
    name: 'sdlc__x',
    title: 'x',
    description: 'a'.repeat(200),
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    _meta: {},
    ...overrides,
  });

  it('flags a description too short to onboard anyone', () => {
    expect(lintMcpTool(tool({ description: 'does stuff' }))[0]?.message).toMatch(/shorter than 80/);
  });

  it('flags an argument with no description', () => {
    const findings = lintMcpTool(
      tool({ inputSchema: { type: 'object', properties: { id: { type: 'string' } } } }),
    );
    expect(findings.map((finding) => finding.message).join(' ')).toMatch(/"id" has no description/);
  });

  it('says nothing about a well-formed tool', () => {
    expect(lintMcpTool(serverDocument([skill()]).tools[0] as McpTool)).toEqual([]);
  });

  it('is a warning, never a block', () => {
    // ADR-0024 makes description quality a house rule, not a gate. A lint that
    // refuses to compile turns a style note into an outage.
    const findings = lintMcpTool(tool({ description: 'short' }));
    expect(findings.every((finding) => finding.severity === 'warning')).toBe(true);
  });
});

describe('detection', () => {
  it('reports what it found, not a bare boolean', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-detect-'));
    tempDirs.push(dir);
    await fs.writeFile(path.join(dir, '.mcp.json'), '{}', 'utf8');

    const report = await adapter.detect(dir);
    expect(report.present).toBe(true);
    expect(report.findings).toContain('found .mcp.json');
  });

  it('reports absence without erroring', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-detect-'));
    tempDirs.push(dir);
    const report = await adapter.detect(dir);
    expect(report.present).toBe(false);
    expect(report.findings).toEqual([]);
  });
});
