import fs from 'node:fs/promises';
import path from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import type { CanonicalSkill } from '@sdlc-on-fire/core';
import { renderPromptTemplate } from '../prompt.js';
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
 * OpenAI Codex — a first-class target (P8-CODEX-01, ADR-0063).
 *
 * [ADR-0063] names **Codex support** as one of the two things that make v0.2's
 * claim honest. Six targets existed and none of them was Codex; it was reached
 * only because the OpenCode target happens to write `AGENTS.md`. That is
 * coverage by coincidence, and it was wrong in a way nobody could see from
 * inside: `agents doctor` could not report Codex at all, no capability table
 * said what Codex drops, and [R-10]/[R-11] — both of which name Codex — had no
 * surface to fire against.
 *
 * ## What Codex actually reads, checked 2026-08-31
 *
 * Tier A per ADR-0073 — OpenAI's own documentation, fetched this session, not
 * recalled:
 *
 *   * **Skills** live at `.agents/skills/<name>/SKILL.md`, discovered
 *     repository-first (`.agents/skills` from the cwd up to the repo root),
 *     then `$HOME/.agents/skills`, then `/etc/codex/skills`, then bundled.
 *     `SKILL.md` "must include `name` and `description`" — the same two fields
 *     Claude Code requires, which is why the frontmatter here is deliberately
 *     minimal rather than a copy of the Claude table.
 *   * **Instructions** come from `AGENTS.md`, merged root-down, with files
 *     closer to the working directory overriding earlier guidance, and an
 *     `AGENTS.override.md` consulted before each `AGENTS.md`.
 *
 * ## Why this is not the Claude adapter with a different path
 *
 * Two differences are load-bearing rather than cosmetic.
 *
 * **The directory is `.agents/`, not `.codex/`.** The natural guess is wrong,
 * and guessing it would produce a tree Codex silently ignores while our doctor
 * reported success — the failure mode that made Cursor's `.mdc` extension
 * load-bearing.
 *
 * **`allowed_tools` has no Codex equivalent in `SKILL.md`.** Claude Code's
 * frontmatter narrows what a skill may reach; Codex's does not, so a skill that
 * declares a tool restriction compiles to a document that **does not enforce
 * it**. Dropping that silently would be the worst kind of quiet difference: the
 * canonical skill says the boundary exists, the compiled artifact does not
 * carry it, and nothing between them says so. It is a warning, every time.
 */

export const CODEX_ID = 'codex';

/** Where Codex looks for repository skills. Not `.codex/` — see the module note. */
export const CODEX_SKILLS_DIR = '.agents/skills';

/**
 * The capability table.
 *
 * Every canonical field appears exactly once — the port's totality check is
 * what stops a forgotten field from silently compiling a security boundary
 * away, and it has caught one before.
 */
export const CODEX_CAPABILITY_TABLE: readonly CapabilityRow[] = [
  { field: 'schema_version', support: 'dropped', note: 'compiler-side gate; not agent-facing' },
  { field: 'name', support: 'mapped', nativeField: 'name' },
  { field: 'description', support: 'mapped', nativeField: 'description' },
  {
    field: 'stage',
    support: 'dropped',
    note: 'lifecycle concern; the daemon decides which skill applies',
  },
  { field: 'situation', support: 'dropped', note: 'dispatch trigger; daemon-side' },
  {
    field: 'user_invoked',
    support: 'dropped',
    note: 'Codex slash commands are a separate surface from skills; a skill is model-invoked',
  },
  { field: 'tier', support: 'dropped', note: 'dispatch-time concern, same as MCP' },
  {
    field: 'context_pack_spec_ref',
    support: 'passthrough',
    nativeField: 'body',
    note: 'the pack is assembled by the daemon; the reference is stated in the body',
  },
  { field: 'role', support: 'passthrough', nativeField: 'body' },
  { field: 'constitution_excerpt_ref', support: 'passthrough', nativeField: 'body' },
  { field: 'task', support: 'passthrough', nativeField: 'body' },
  { field: 'output_contract', support: 'passthrough', nativeField: 'body' },
  { field: 'self_verification', support: 'passthrough', nativeField: 'body' },
  { field: 'stop_condition', support: 'passthrough', nativeField: 'body' },
  { field: 'verify', support: 'passthrough', nativeField: 'body' },
  {
    field: 'arguments',
    support: 'dropped',
    note: 'SKILL.md declares no argument schema; a slot with nothing to bind to is a compile error upstream (Q-12)',
  },
  {
    field: 'paths',
    support: 'passthrough',
    nativeField: 'body',
    note: 'SKILL.md has no glob field; the scope is stated in the body where the model can read it',
  },
  {
    field: 'allowed_tools',
    support: 'dropped',
    note: 'no equivalent in Codex SKILL.md frontmatter — the restriction is NOT enforced by the compiled artifact, and compiling one emits a warning',
  },
  {
    field: 'disallowed_tools',
    support: 'dropped',
    note: 'same as allowed_tools — stated in the body, enforced nowhere',
  },
  {
    field: 'context_mode',
    support: 'dropped',
    note: 'our own assembly knob; Codex has no notion of it',
  },
  {
    field: 'deprecation',
    support: 'passthrough',
    nativeField: 'body',
    note: 'stated in the body; SKILL.md has no retirement field',
  },
  {
    field: 'hooks',
    support: 'dropped',
    note: 'Codex has no per-skill hook contract; `agents/openai.yaml` carries display metadata, not lifecycle hooks',
  },
];

/**
 * The tool-restriction warning.
 *
 * Emitted per skill that declares one, and worded so a reader knows the
 * difference between "this target renders it differently" and "this target does
 * not enforce it". Only the second is a security-relevant fact.
 */
function toolRestrictionWarnings(skill: CanonicalSkill): CompileWarning[] {
  const declared: string[] = [];
  if ((skill.allowed_tools ?? []).length > 0) declared.push('allowed_tools');
  if ((skill.disallowed_tools ?? []).length > 0) declared.push('disallowed_tools');
  if (declared.length === 0) return [];
  return declared.map((field) => ({
    field,
    target: CODEX_ID,
    severity: 'warning' as const,
    message:
      `Codex SKILL.md has no ${field} field, so "${skill.name}" compiles to a document that ` +
      'states the restriction and does not enforce it. Treat it as guidance to the model, not a boundary.',
  }));
}

export class CodexAdapter implements AgentAdapter {
  readonly id = CODEX_ID;
  readonly capabilityTable = CODEX_CAPABILITY_TABLE;
  readonly maxSchemaVersion = '0.1.0';

  compileSkill(skill: CanonicalSkill): CompileResult {
    // `name` and `description` and nothing else. Codex documents these two as
    // required and says richer metadata belongs in `agents/openai.yaml`, so
    // adding fields here would be inventing a contract on the vendor's behalf —
    // the mistake that put a `arguments` block Claude Code does not read into a
    // compiled skill once already.
    const frontmatter = { name: skill.name, description: skill.description };
    const body = renderPromptTemplate(skill).text;

    const file: CompiledFile = {
      path: `${CODEX_SKILLS_DIR}/${skill.name}/SKILL.md`,
      content: `---\n${stringifyYaml(frontmatter, { lineWidth: 0 })}---\n\n${body}\n`,
      mode: 'overwrite',
    };

    return { files: [file], warnings: toolRestrictionWarnings(skill) };
  }

  /** Reporting only — never silent auto-targeting (ADR-0007). */
  async detect(projectRoot: string): Promise<DetectionReport> {
    const findings: string[] = [];
    // `.agents/skills` first: it is the specific signal. `AGENTS.md` is the
    // cross-tool convention half a dozen tools read, so on its own it says
    // "some agent runs here", not "Codex does".
    for (const candidate of [CODEX_SKILLS_DIR, '.codex', 'AGENTS.md']) {
      try {
        await fs.stat(path.join(projectRoot, candidate));
        findings.push(`found ${candidate}`);
      } catch {
        // Absence is a finding's absence, not an error.
      }
    }
    return { target: this.id, present: findings.length > 0, findings };
  }
}

/** Every canonical field is accounted for exactly once (port §3, totality). */
export const CODEX_COVERS_EVERY_FIELD = CANONICAL_SKILL_FIELDS.every((field) =>
  CODEX_CAPABILITY_TABLE.some((row) => row.field === field),
);
