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
 * The Claude Code adapter, per contracts/04-skill-ir.md §4.1.
 *
 * v0.1 ships this target only — Codex is deferred (mvp-slice), and the port
 * exists so adding it is additive rather than a refactor.
 *
 * Compilation is **mechanical field projection, not generation**: no model call
 * happens here, and the same skill in must always produce byte-identical files
 * out (§3, contract requirement 1). Generation happens once, earlier, at
 * skill-authoring time.
 */

export const CLAUDE_CODE_ID = 'claude-code';

/** ADR-0028's 3-tier scale onto Claude Code's own effort scale. Never invents a 4th tier. */
export const TIER_TO_EFFORT: Record<CanonicalSkill['tier'], string> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
};

/**
 * Every canonical field, and what this adapter does with it.
 *
 * Totality is the contract (§3): a field is mapped, passed through, or
 * explicitly dropped. Silence is not an option — an unaccounted field is caught
 * by `missingCapabilityRows()`.
 */
export const CLAUDE_CAPABILITY_TABLE: readonly CapabilityRow[] = [
  { field: 'schema_version', support: 'dropped', note: 'compiler-side gate; not agent-facing' },
  { field: 'name', support: 'mapped', nativeField: 'name' },
  { field: 'description', support: 'mapped', nativeField: 'description' },
  { field: 'stage', support: 'dropped', note: 'lifecycle concern; daemon-side' },
  { field: 'tier', support: 'mapped', nativeField: 'effort' },
  { field: 'context_pack_spec_ref', support: 'dropped', note: 'resolved at assembly time' },
  { field: 'role', support: 'mapped', nativeField: 'body' },
  { field: 'constitution_excerpt_ref', support: 'dropped', note: 'resolved into the context pack' },
  { field: 'task', support: 'mapped', nativeField: 'body' },
  { field: 'output_contract', support: 'mapped', nativeField: 'body' },
  { field: 'self_verification', support: 'mapped', nativeField: 'body' },
  { field: 'stop_condition', support: 'mapped', nativeField: 'body' },
  {
    field: 'verify',
    support: 'dropped',
    note: 'daemon invokes verify; the compiled file only describes it (architecture §5)',
  },
  { field: 'arguments', support: 'passthrough', nativeField: 'arguments' },
  { field: 'paths', support: 'passthrough', nativeField: 'paths' },
  { field: 'allowed_tools', support: 'passthrough', nativeField: 'allowed-tools' },
  { field: 'disallowed_tools', support: 'passthrough', nativeField: 'disallowed-tools' },
  { field: 'context_mode', support: 'mapped', nativeField: 'context' },
  { field: 'deprecation', support: 'dropped', note: 'doctor-only; never agent-facing' },
  { field: 'hooks', support: 'passthrough', nativeField: 'hooks' },
];

function skillFrontmatter(skill: CanonicalSkill): Record<string, unknown> {
  const frontmatter: Record<string, unknown> = {
    name: skill.name,
    description: skill.description,
    effort: TIER_TO_EFFORT[skill.tier],
  };

  // `inline` is Claude Code's default, so emitting it would be noise.
  if (skill.context_mode === 'fork') frontmatter['context'] = 'fork';
  if (skill.arguments !== undefined) frontmatter['arguments'] = skill.arguments;
  if (skill.paths !== undefined) frontmatter['paths'] = skill.paths;
  if (skill.allowed_tools !== undefined) frontmatter['allowed-tools'] = skill.allowed_tools;
  if (skill.disallowed_tools !== undefined) {
    frontmatter['disallowed-tools'] = skill.disallowed_tools;
  }
  if (skill.hooks !== undefined) frontmatter['hooks'] = skill.hooks;

  return frontmatter;
}

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly id = CLAUDE_CODE_ID;
  readonly capabilityTable = CLAUDE_CAPABILITY_TABLE;
  readonly maxSchemaVersion = '0.1.0';

  compileSkill(skill: CanonicalSkill): CompileResult {
    const warnings: CompileWarning[] = [];

    // A deprecated skill still compiles — refusing would break a working
    // workspace on an upgrade. Reporting it is `runDoctor`'s job, not this
    // adapter's: deprecation is a property of the skill, so emitting it here
    // repeated the same retirement once per configured target (P0-AGENT-05).

    const body = renderPromptTemplate(skill).text;
    const yaml = stringifyYaml(skillFrontmatter(skill), { lineWidth: 0 });

    const file: CompiledFile = {
      path: `.claude/skills/${skill.name}/SKILL.md`,
      content: `---\n${yaml}---\n\n${body}\n`,
      mode: 'overwrite',
    };

    return { files: [file], warnings };
  }

  /** Reporting only — never silent auto-targeting (ADR-0007). */
  async detect(projectRoot: string): Promise<DetectionReport> {
    const findings: string[] = [];
    for (const candidate of ['.claude', 'CLAUDE.md']) {
      const full = path.join(projectRoot, candidate);
      try {
        await fs.stat(full);
        findings.push(`found ${candidate}`);
      } catch {
        // Absence is a finding's absence, not an error.
      }
    }
    return { target: this.id, present: findings.length > 0, findings };
  }
}

/** Guards against a capability row being forgotten when a canonical field is added. */
export const CLAUDE_COVERS_ALL_FIELDS: boolean = CANONICAL_SKILL_FIELDS.every((field) =>
  CLAUDE_CAPABILITY_TABLE.some((row) => row.field === field),
);
