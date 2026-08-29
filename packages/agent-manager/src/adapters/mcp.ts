import fs from 'node:fs/promises';
import path from 'node:path';
import { deferralPlan, type CanonicalSkill } from '@sdlc-on-fire/core';
import { toolBudget } from './tool-budget.js';
import { outputJsonSchema } from '../skills/output-schemas.js';
import {
  CANONICAL_SKILL_FIELDS,
  type AgentAdapter,
  type CapabilityRow,
  type CompiledFile,
  type CompileResult,
  type CompileWarning,
  type DetectionReport,
} from '../port.js';

/**
 * The MCP compile target (P2-AGT-01, ADR-0024, contracts/04 §4.3).
 *
 * Spec revision **2025-11-25**. Every shape below was read off the published
 * spec rather than remembered, because the failure mode for a compiled protocol
 * artifact is not an exception — it is a document a client accepts, lists, and
 * cannot use.
 *
 * Three things about this target are different from Claude Code, and each one
 * changed a decision rather than just an output format.
 *
 * **The artifact is per-workspace, not per-skill.** A server is one document
 * listing every tool it exposes *and declaring what it supports*, and neither
 * of those can be derived from one skill in isolation. That is why the port
 * grew `compileServer` (contract §3.1) instead of this file concatenating
 * results somewhere downstream.
 *
 * **Capabilities are a promise.** Declaring `resources` when none are published
 * makes a client call `resources/list` and get an error; declaring
 * `listChanged: true` when nothing sends the notification makes it wait for one
 * that is not coming. So `capabilities` is *computed from the emitted
 * document*. There is no literal capability block anywhere in this file to get
 * out of date.
 *
 * **`annotations` are not a boundary.** The spec tells clients to treat tool
 * annotations as untrusted unless the server is trusted, which makes them hints
 * a client may ignore. `allowed_tools`/`disallowed_tools` are a security
 * boundary, so compiling them into annotations would convert an enforcement
 * into a suggestion — and it would look correct. They go into `_meta` under our
 * own reverse-DNS prefix, where they are server-side data rather than a request
 * to the client.
 */

/** The spec revision this adapter compiles against. */
export const MCP_PROTOCOL_VERSION = '2025-11-25';

export const MCP_ID = 'mcp';

/** Service prefix, per ADR-0024's namespacing house rule. */
export const MCP_TOOL_PREFIX = 'sdlc__';

export const MCP_SERVER_NAME = 'sdlc-on-fire';

/**
 * `_meta` prefix for anything that is ours rather than the protocol's.
 *
 * The spec reserves any prefix whose second label is `modelcontextprotocol` or
 * `mcp` and recommends reverse-DNS otherwise. `dev.sdlc-on-fire/` satisfies
 * both — and using the spec's own extension point matters more than it sounds:
 * a sibling top-level field would be silently dropped by a conforming client,
 * so the trust tag would vanish exactly where it is needed.
 */
export const MCP_META_PREFIX = 'dev.sdlc-on-fire/';

/**
 * Legal tool names, per the spec: 1–128 characters from `[A-Za-z0-9_.-]`.
 *
 * Our skill names are kebab-case, so `sdlc__resolve-conflict` is legal — but
 * checked rather than assumed. A name outside the set produces a tool that
 * lists and cannot be called, which is the same shape as every other defect
 * this codebase has shipped: it compiles, it looks installed, it does nothing.
 */
const LEGAL_TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;

/** Our slot syntax, `{{like_this}}` — the same one the Claude adapter rewrites. */
const SLOT = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

/** `work-item-id` → `work_item_id`, so a declared argument matches its slot. */
const slotNameFor = (argumentName: string): string => argumentName.replace(/-/g, '_');

export interface McpTool {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly outputSchema?: unknown;
  readonly _meta: Record<string, unknown>;
}

export interface McpServerDocument {
  readonly protocolVersion: string;
  readonly serverInfo: { readonly name: string; readonly title: string; readonly version: string };
  readonly capabilities: Record<string, unknown>;
  readonly instructions: string;
  /** Our extensions, namespaced. Never protocol fields (§ the `_meta` rule above). */
  readonly _meta?: Record<string, unknown> | undefined;
  readonly tools: readonly McpTool[];
}

/**
 * Every canonical field, and what this adapter does with it.
 *
 * Totality is the contract (§3): mapped, passed through, or explicitly dropped.
 */
export const MCP_CAPABILITY_TABLE: readonly CapabilityRow[] = [
  { field: 'schema_version', support: 'dropped', note: 'compiler-side gate; not agent-facing' },
  {
    field: 'name',
    support: 'mapped',
    nativeField: 'tools[].name',
    note: 'service-prefixed; spec character set and 128-char limit enforced',
  },
  { field: 'description', support: 'mapped', nativeField: 'tools[].description' },
  { field: 'stage', support: 'dropped', note: 'lifecycle concern; daemon-side dispatch' },
  { field: 'situation', support: 'dropped', note: 'as `stage` — dispatch, not artifact' },
  {
    field: 'user_invoked',
    support: 'dropped',
    note: 'dispatch trigger; the invocation IS the user',
  },
  { field: 'tier', support: 'dropped', note: 'dispatch-time concern, same as Codex' },
  { field: 'context_pack_spec_ref', support: 'dropped', note: 'MCP resource form deferred (§4.3)' },
  {
    field: 'role',
    support: 'mapped',
    nativeField: 'tools[].description',
    note: 'MCP has no role concept; the client supplies its own system prompt',
  },
  { field: 'constitution_excerpt_ref', support: 'dropped', note: 'resolved into the context pack' },
  { field: 'task', support: 'mapped', nativeField: 'tools[].description' },
  {
    field: 'output_contract',
    support: 'mapped',
    nativeField: 'tools[].outputSchema',
    note: 'the Zod-derived JSON Schema, reused rather than re-authored',
  },
  { field: 'self_verification', support: 'mapped', nativeField: 'tools[].description' },
  { field: 'stop_condition', support: 'mapped', nativeField: 'tools[].description' },
  {
    field: 'verify',
    support: 'dropped',
    note: 'daemon invokes verify; never an artifact concern (architecture §5)',
  },
  {
    field: 'arguments',
    support: 'mapped',
    nativeField: 'tools[].inputSchema',
    note: '`required` from the canonical flag; property descriptions from `description`',
  },
  {
    field: 'paths',
    support: 'dropped',
    note: 'no MCP equivalent; scoping is per tool, not per path',
  },
  {
    field: 'allowed_tools',
    support: 'mapped',
    nativeField: '_meta scopes',
    note: 'deliberately NOT annotations — the spec tells clients those are untrusted hints',
  },
  {
    field: 'disallowed_tools',
    support: 'mapped',
    nativeField: '_meta scopes',
    note: 'as `allowed_tools`',
  },
  { field: 'context_mode', support: 'dropped', note: 'the client owns its own context' },
  { field: 'deprecation', support: 'dropped', note: 'doctor-only; never agent-facing' },
  { field: 'hooks', support: 'dropped', note: 'no MCP equivalent (Claude-only)' },
];

export const MCP_COVERS_ALL_FIELDS: boolean = CANONICAL_SKILL_FIELDS.every((field) =>
  MCP_CAPABILITY_TABLE.some((row) => row.field === field),
);

/** The tool name a skill compiles to. Throws rather than emit an uncallable tool. */
export function mcpToolName(skill: CanonicalSkill): string {
  const name = `${MCP_TOOL_PREFIX}${skill.name}`;
  if (!LEGAL_TOOL_NAME.test(name)) {
    throw new Error(
      `${skill.name}: cannot compile for mcp — "${name}" is not a legal tool name. ` +
        'The 2025-11-25 spec allows 1–128 characters from [A-Za-z0-9_.-]; this one would be ' +
        'listed by the server and rejected by the client, which reads as a tool that exists ' +
        'and never works.',
    );
  }
  return name;
}

/**
 * The tool description.
 *
 * `role`, `self_verification` and `stop_condition` are folded in because MCP
 * gives them nowhere else to go: the client writes its own system prompt around
 * the call, so anything not in the description is not said. That makes this the
 * one place the anti-self-report clause survives into an MCP surface, which is
 * why it is not treated as decoration.
 *
 * Slots are rendered as `<argument-name>` — a placeholder that names the input
 * property the caller fills. An unbound slot is a compile error, the same rule
 * the Claude Code adapter enforces and for the same reason: a blank in an
 * agent's instructions gets answered anyway, and an MCP tool's only channel for
 * filling one is `inputSchema`.
 */
export function mcpToolDescription(skill: CanonicalSkill): string {
  const declared = new Set((skill.arguments ?? []).map((argument) => slotNameFor(argument.name)));
  const bySlot = new Map(
    (skill.arguments ?? []).map((argument) => [slotNameFor(argument.name), argument.name]),
  );

  const unbound = new Set<string>();
  const fill = (text: string): string =>
    text.replace(SLOT, (whole, slot: string) => {
      if (!declared.has(slot)) {
        unbound.add(slot);
        return whole;
      }
      return `<${bySlot.get(slot) ?? slot}>`;
    });

  const sections = [
    skill.description,
    '',
    `Role: ${fill(skill.role)}`,
    '',
    fill(skill.task),
    '',
    `Stop when: ${fill(skill.stop_condition)}`,
  ];
  if (skill.self_verification !== undefined) {
    sections.push('', `Before returning: ${fill(skill.self_verification)}`);
  }
  sections.push(
    '',
    `Results are returned through \`${skill.output_contract.tool_name}\` and must satisfy this tool's outputSchema.`,
  );

  if (unbound.size > 0) {
    throw new Error(
      `${skill.name}: cannot compile for mcp — ` +
        `${[...unbound].map((slot) => `{{${slot}}}`).join(', ')} has no declared argument to bind to. ` +
        'The tool would hand the model a blank with no input property to fill it from, and the ' +
        'model would fill it anyway. Either declare the argument or take the slot out of the skill text.',
    );
  }
  return sections.join('\n');
}

/**
 * The tool's input schema.
 *
 * Always an object, never absent and never `{}`. The spec is explicit that
 * `inputSchema` MUST be a valid JSON Schema object, and names the right answer
 * for a tool with no parameters: `{"type":"object","additionalProperties":false}`
 * — which says "this tool takes nothing" rather than "this tool takes
 * anything".
 */
export function mcpInputSchema(skill: CanonicalSkill): Record<string, unknown> {
  const args = skill.arguments ?? [];
  if (args.length === 0) return { type: 'object', additionalProperties: false };

  const properties: Record<string, unknown> = {};
  for (const argument of args) {
    properties[argument.name] = {
      type: 'string',
      ...(argument.description === undefined ? {} : { description: argument.description }),
    };
  }

  const required = args.filter((argument) => argument.required).map((argument) => argument.name);
  return {
    type: 'object',
    properties,
    // From the canonical flag, not from "everything" or "nothing". A schema
    // that marks a required argument optional lets the model call the tool
    // without it, and the skill then runs on a blank it was promised.
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
}

/** ADR-0024's tool-description house rules, as `doctor` findings. */
export function lintMcpTool(tool: McpTool): CompileWarning[] {
  const warnings: CompileWarning[] = [];
  const finding = (message: string, field: string): CompileWarning => ({
    field,
    target: MCP_ID,
    severity: 'warning',
    message: `${tool.name}: ${message}`,
  });

  if (tool.description.length < 80) {
    warnings.push(
      finding(
        'description is shorter than 80 characters — ADR-0024 asks for descriptions written ' +
          'like onboarding a new engineer, and tool-use accuracy measurably follows',
        'description',
      ),
    );
  }

  const properties = (tool.inputSchema['properties'] ?? {}) as Record<string, unknown>;
  for (const [name, shape] of Object.entries(properties)) {
    if ((shape as { description?: string }).description === undefined) {
      warnings.push(
        finding(
          `argument "${name}" has no description — the property description is the whole of ` +
            'what the model is told about it',
          'arguments',
        ),
      );
    }
  }

  return warnings;
}

/**
 * The capabilities a document actually backs.
 *
 * Derived, never declared. `prompts` and `resources` are absent because nothing
 * publishes them yet — and their absence is the honest report, not an omission
 * to fill in later. `listChanged` is `false` because this is a compiled,
 * static document: a server built from it changes when the workspace is
 * recompiled and the client reconnects, not by notification.
 */
export function mcpCapabilities(tools: readonly McpTool[]): Record<string, unknown> {
  const capabilities: Record<string, unknown> = {};
  if (tools.length > 0) capabilities['tools'] = { listChanged: false };
  return capabilities;
}

export class McpAdapter implements AgentAdapter {
  readonly id = MCP_ID;
  readonly capabilityTable = MCP_CAPABILITY_TABLE;
  readonly maxSchemaVersion = '0.1.0';

  readonly #version: string;

  constructor(version = '0.1.0') {
    this.#version = version;
  }

  /** One skill's tool definition. `doctor` validates per skill; the workspace installs the server. */
  compileSkill(skill: CanonicalSkill): CompileResult {
    const tool = this.#toolFor(skill);
    return {
      files: [
        {
          path: `.mcp/tools/${tool.name}.json`,
          content: `${JSON.stringify(tool, null, 2)}\n`,
          mode: 'overwrite',
        },
      ],
      warnings: lintMcpTool(tool),
    };
  }

  /** The server document — the artifact a workspace actually installs (contract §3.1). */
  compileServer(skills: readonly CanonicalSkill[]): CompileResult {
    // Sorted by name so recompiling unchanged input produces a zero diff
    // regardless of the order the loader happened to read the directory in
    // (contract point 4). Directory order is not stable across platforms, and
    // an idempotency check that passes on the author's machine is not one.
    const tools = [...skills]
      .map((skill) => this.#toolFor(skill))
      .sort((a, b) => a.name.localeCompare(b.name));

    const duplicates = tools
      .map((tool) => tool.name)
      .filter((name, index, all) => all.indexOf(name) !== index);
    if (duplicates.length > 0) {
      // The spec says names SHOULD be unique within a server; two tools with
      // one name means a call resolves to whichever the server indexed last.
      throw new Error(
        `cannot compile the mcp server — duplicate tool name(s): ${[...new Set(duplicates)].join(', ')}`,
      );
    }

    // The deferred-loading plan, published as data (P2-AGT-02).
    //
    // We do not set `defer_loading` on these definitions, and cannot: for tools
    // reaching a model through the MCP connector, the flag belongs to the
    // *consumer's* `mcp_toolset` entry, not to the server that publishes them.
    // What we can supply is the answer to "which of these should stay loaded",
    // which is otherwise a guess made by whoever writes that config.
    //
    // Under `_meta`, because it is ours and not the protocol's — the same rule
    // every other extension in this adapter follows.
    const plan = deferralPlan(skills);
    const budget = toolBudget(tools);

    const document: McpServerDocument = {
      protocolVersion: MCP_PROTOCOL_VERSION,
      serverInfo: { name: MCP_SERVER_NAME, title: 'SDLC on Fire', version: this.#version },
      _meta: {
        'sdlc-on-fire/tool-budget': {
          tools: budget.tools,
          tokens: budget.tokens,
          threshold: budget.threshold,
          deferralRecommended: budget.conditionMet,
          because: budget.because,
        },
        'sdlc-on-fire/deferral-plan': {
          keepLoaded: plan.hot.map((decision) => decision.name),
          defer: plan.deferred.map((decision) => decision.name),
          because: plan.because,
          reasons: Object.fromEntries(
            [...plan.hot, ...plan.deferred].map((decision) => [decision.name, decision.because]),
          ),
        },
      },
      capabilities: mcpCapabilities(tools),
      instructions:
        'Each tool runs one lifecycle skill. Tools report what they produced; they never ' +
        'report whether their own work passed — verification is run separately by the daemon ' +
        'and is not something a tool result can assert.',
      tools,
    };

    const file: CompiledFile = {
      path: `.mcp/${MCP_SERVER_NAME}.json`,
      content: `${JSON.stringify(document, null, 2)}\n`,
      mode: 'overwrite',
    };

    return { files: [file], warnings: tools.flatMap((tool) => lintMcpTool(tool)) };
  }

  /** Reporting only — never silent auto-targeting (ADR-0007). */
  async detect(projectRoot: string): Promise<DetectionReport> {
    const findings: string[] = [];
    for (const candidate of ['.mcp.json', '.mcp']) {
      try {
        await fs.stat(path.join(projectRoot, candidate));
        findings.push(`found ${candidate}`);
      } catch {
        // Absence is a finding's absence, not an error.
      }
    }
    return { target: this.id, present: findings.length > 0, findings };
  }

  #toolFor(skill: CanonicalSkill): McpTool {
    const outputSchema = outputJsonSchema(skill.output_contract.json_schema_ref);
    if (outputSchema === undefined) {
      // Not an omitted field. A tool with no `outputSchema` and a tool whose
      // schema failed to resolve are indistinguishable to a client, and the
      // second one is a contract that silently stopped being enforced.
      throw new Error(
        `${skill.name}: cannot compile for mcp — json_schema_ref ` +
          `"${skill.output_contract.json_schema_ref}" resolves to nothing.`,
      );
    }

    const scopes = {
      ...(skill.allowed_tools === undefined ? {} : { allowed: skill.allowed_tools }),
      ...(skill.disallowed_tools === undefined ? {} : { disallowed: skill.disallowed_tools }),
    };

    return {
      name: mcpToolName(skill),
      title: skill.name,
      description: mcpToolDescription(skill),
      inputSchema: mcpInputSchema(skill),
      outputSchema,
      _meta: {
        // Compiled from a canonical skill, so reviewed by construction. A tool
        // `doctor` finds that did not come from a compile is `untrusted`
        // (contract §5.2) — the distinction exists because the two directions
        // have different validation bars, not because the string is decorative.
        [`${MCP_META_PREFIX}trust`]: 'first-party-reviewed',
        ...(Object.keys(scopes).length > 0 ? { [`${MCP_META_PREFIX}scopes`]: scopes } : {}),
      },
    };
  }
}
