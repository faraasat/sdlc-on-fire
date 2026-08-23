/**
 * Four more compile targets (P5-ADAPT-01): Cursor, GitHub Copilot, Gemini CLI,
 * OpenCode.
 *
 * All four are markdown, and they split cleanly into two shapes that matter
 * more than the four names:
 *
 *   * **Scoped** — Cursor and Copilot attach a rule to files by glob, so a
 *     skill's `paths` becomes native activation and the agent only sees the
 *     rule when it is working somewhere relevant. Both carry frontmatter, so
 *     `description` survives as a field rather than as prose.
 *   * **Ambient** — Gemini CLI (`GEMINI.md`) and OpenCode (`AGENTS.md`) read one
 *     document, always, for the whole project. Everything conditional is
 *     dropped, and the capability tables say so rather than pretending
 *     otherwise.
 *
 * That difference is why this is one file with two builders instead of four
 * copies. Four near-identical adapters is how one of them quietly stops
 * matching the others.
 *
 * **Formats are the vendors' own, checked 2026-08-22** — tier A per ADR-0073:
 * `.cursor/rules/<name>.mdc` with `description` / `globs` / `alwaysApply`
 * (cursor.com/docs), and `.github/instructions/<name>.instructions.md` with a
 * required `applyTo` glob list plus optional `excludeAgent`
 * (docs.github.com). `GEMINI.md` and `AGENTS.md` are plain markdown with no
 * frontmatter contract to honour; `AGENTS.md` is the cross-tool convention
 * OpenCode reads, which is why OpenCode's target is a file we already emit for
 * Codex rather than something OpenCode-specific.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import type { CanonicalSkill } from '@sdlc-on-fire/core';
import { renderPromptTemplate } from '../prompt.js';
import {
  CANONICAL_SKILL_FIELDS,
  type AgentAdapter,
  type CapabilityRow,
  type CompileResult,
  type CompileWarning,
  type DetectionReport,
} from '../port.js';

/** Fields every markdown target handles identically: they become prose in the body. */
const BODY_FIELDS = [
  'role',
  'task',
  'output_contract',
  'self_verification',
  'stop_condition',
  'verify',
] as const;

/** Fields no markdown target can express, with the reason each is dropped. */
const DROPPED: readonly CapabilityRow[] = [
  { field: 'schema_version', support: 'dropped', note: 'compiler-side gate; not agent-facing' },
  { field: 'stage', support: 'dropped', note: 'lifecycle concern; daemon-side' },
  { field: 'situation', support: 'dropped', note: 'dispatch trigger; daemon-side' },
  {
    field: 'user_invoked',
    support: 'dropped',
    note: 'dispatch trigger; the invocation IS the user',
  },
  { field: 'tier', support: 'dropped', note: 'no effort or model control in this format' },
  { field: 'context_pack_spec_ref', support: 'dropped', note: 'resolved at assembly time' },
  { field: 'constitution_excerpt_ref', support: 'dropped', note: 'resolved into the context pack' },
  {
    field: 'allowed_tools',
    support: 'dropped',
    note: 'no tool-permission surface — the agent decides, so this is guidance at best',
  },
  {
    field: 'disallowed_tools',
    support: 'dropped',
    note: 'no tool-permission surface; a denial we cannot enforce must not read as enforced',
  },
  { field: 'context_mode', support: 'dropped', note: 'no context-window control in this format' },
  { field: 'hooks', support: 'dropped', note: 'no lifecycle hook surface' },
  {
    field: 'arguments',
    support: 'dropped',
    note: 'no argument schema in a prose instruction file',
  },
];

const bodyRows = (): CapabilityRow[] =>
  BODY_FIELDS.map((field) => ({ field, support: 'mapped' as const, nativeField: 'body' }));

/** Table for a target that can scope by file glob. */
function scopedTable(nativeGlob: string, nativeDescription: string): readonly CapabilityRow[] {
  return [
    ...DROPPED,
    { field: 'name', support: 'mapped', nativeField: 'filename' },
    { field: 'description', support: 'mapped', nativeField: nativeDescription },
    { field: 'paths', support: 'mapped', nativeField: nativeGlob },
    {
      field: 'deprecation',
      support: 'passthrough',
      nativeField: 'body',
      note: 'stated in the body; the format has no retirement field',
    },
    ...bodyRows(),
  ];
}

/** Table for a target that reads one document for the whole project. */
function ambientTable(): readonly CapabilityRow[] {
  return [
    ...DROPPED,
    { field: 'name', support: 'mapped', nativeField: 'heading' },
    { field: 'description', support: 'mapped', nativeField: 'body' },
    {
      field: 'paths',
      support: 'dropped',
      note: 'the file is read for the whole project, so a path scope cannot be honoured — dropping it is more honest than writing it where nothing reads it',
    },
    { field: 'deprecation', support: 'passthrough', nativeField: 'body' },
    ...bodyRows(),
  ];
}

/** A note appended when a skill declares paths a target cannot enforce. */
function unscopedWarning(skill: CanonicalSkill, adapterId: string, file: string): CompileWarning[] {
  const paths = skill.paths ?? '';
  if (paths.trim() === '') return [];
  return [
    {
      field: 'paths',
      target: adapterId,
      severity: 'warning',
      message: `${file} is read for the whole project, so "${skill.name}" applies everywhere despite declaring the scope "${paths}"`,
    },
  ];
}

async function detectAny(
  target: string,
  projectRoot: string,
  candidates: readonly string[],
): Promise<DetectionReport> {
  const findings: string[] = [];
  for (const candidate of candidates) {
    try {
      await fs.stat(path.join(projectRoot, candidate));
      findings.push(`found ${candidate}`);
    } catch {
      // Absence is a finding's absence, not an error.
    }
  }
  return { target, present: findings.length > 0, findings };
}

export const CURSOR_ID = 'cursor';
export const COPILOT_ID = 'copilot';
export const GEMINI_ID = 'gemini';
export const OPENCODE_ID = 'opencode';

/**
 * Cursor — `.cursor/rules/<name>.mdc`.
 *
 * `.mdc`, not `.md`: Cursor ignores plain markdown in that directory, so the
 * extension is load-bearing rather than stylistic. `alwaysApply` is false
 * whenever the skill declares paths, because a rule that is both globbed and
 * always-applied is just always-applied — and the globs would read as a scope
 * that is not one.
 */
export class CursorAdapter implements AgentAdapter {
  readonly id = CURSOR_ID;
  readonly capabilityTable = scopedTable('globs', 'description');
  readonly maxSchemaVersion = '0.1.0';

  compileSkill(skill: CanonicalSkill): CompileResult {
    const globs = (skill.paths ?? '').trim();
    const frontmatter: Record<string, unknown> = {
      description: skill.description,
      alwaysApply: globs === '',
    };
    if (globs !== '') frontmatter['globs'] = globs;

    return {
      files: [
        {
          path: `.cursor/rules/${skill.name}.mdc`,
          content: `---\n${stringifyYaml(frontmatter, { lineWidth: 0 })}---\n\n${renderPromptTemplate(skill).text}\n`,
          mode: 'overwrite',
        },
      ],
      warnings: [],
    };
  }

  async detect(projectRoot: string): Promise<DetectionReport> {
    return detectAny(this.id, projectRoot, ['.cursor', '.cursorrules']);
  }
}

/**
 * GitHub Copilot — `.github/instructions/<name>.instructions.md`.
 *
 * `applyTo` is **required** by the format, so a skill with no declared paths
 * gets `**` rather than an omitted field: an instructions file without it is
 * not a valid instructions file, and silently emitting one would produce
 * something Copilot ignores while our `doctor` reported success.
 */
export class CopilotAdapter implements AgentAdapter {
  readonly id = COPILOT_ID;
  readonly capabilityTable = scopedTable('applyTo', 'body');
  readonly maxSchemaVersion = '0.1.0';

  compileSkill(skill: CanonicalSkill): CompileResult {
    const globs = (skill.paths ?? '').trim();
    const applyTo = globs === '' ? '**' : globs;
    return {
      files: [
        {
          path: `.github/instructions/${skill.name}.instructions.md`,
          content: `---\napplyTo: '${applyTo}'\n---\n\n# ${skill.name}\n\n${skill.description}\n\n${renderPromptTemplate(skill).text}\n`,
          mode: 'overwrite',
        },
      ],
      warnings: [],
    };
  }

  async detect(projectRoot: string): Promise<DetectionReport> {
    return detectAny(this.id, projectRoot, [
      '.github/copilot-instructions.md',
      '.github/instructions',
    ]);
  }
}

/** Builds the one-document body shared by the ambient targets. */
function ambientDocument(heading: string, skills: readonly CanonicalSkill[]): string {
  const sections = [...skills]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(
      (skill) =>
        `## ${skill.name}\n\n${skill.description}\n\n${renderPromptTemplate(skill).text}\n`,
    );
  return `# ${heading}\n\nCompiled from this project's canonical skills. Do not edit by hand.\n\n${sections.join('\n')}`;
}

/**
 * Gemini CLI — `GEMINI.md`, one document for the project.
 *
 * Emitted through `compileServer` rather than `compileSkill`, for the reason
 * the port's own docs give about MCP: the artifact is per-workspace, and a
 * per-skill compile would either overwrite the file once per skill or leave the
 * merge to whatever writes files.
 */
export class GeminiAdapter implements AgentAdapter {
  readonly id = GEMINI_ID;
  readonly capabilityTable = ambientTable();
  readonly maxSchemaVersion = '0.1.0';

  compileSkill(skill: CanonicalSkill): CompileResult {
    // One skill is a whole-document compile with one section. Kept so the port
    // stays uniform; `compileServer` is the real entry point.
    return {
      files: this.compileServer([skill]).files,
      warnings: unscopedWarning(skill, this.id, 'GEMINI.md'),
    };
  }

  compileServer(skills: readonly CanonicalSkill[]): CompileResult {
    return {
      files: [
        {
          path: 'GEMINI.md',
          content: ambientDocument('Project instructions', skills),
          mode: 'overwrite',
        },
      ],
      warnings: skills.flatMap((skill) => unscopedWarning(skill, this.id, 'GEMINI.md')),
    };
  }

  async detect(projectRoot: string): Promise<DetectionReport> {
    return detectAny(this.id, projectRoot, ['GEMINI.md', '.gemini']);
  }
}

/**
 * OpenCode — `AGENTS.md`, the cross-tool convention it reads.
 *
 * Its target is a file we already emit for Codex, and that overlap is the
 * finding rather than a coincidence: configuring OpenCode is configuring
 * whatever else reads `AGENTS.md`. `doctor` should say so instead of listing
 * two independent-looking targets that write the same path.
 */
export class OpenCodeAdapter implements AgentAdapter {
  readonly id = OPENCODE_ID;
  readonly capabilityTable = ambientTable();
  readonly maxSchemaVersion = '0.1.0';

  compileSkill(skill: CanonicalSkill): CompileResult {
    return {
      files: this.compileServer([skill]).files,
      warnings: unscopedWarning(skill, this.id, 'AGENTS.md'),
    };
  }

  compileServer(skills: readonly CanonicalSkill[]): CompileResult {
    return {
      files: [
        {
          path: 'AGENTS.md',
          content: ambientDocument('Agent instructions', skills),
          mode: 'overwrite',
        },
      ],
      warnings: skills.flatMap((skill) => unscopedWarning(skill, this.id, 'AGENTS.md')),
    };
  }

  async detect(projectRoot: string): Promise<DetectionReport> {
    return detectAny(this.id, projectRoot, ['AGENTS.md', 'opencode.json', '.opencode']);
  }
}

export const MARKDOWN_ADAPTERS: readonly AgentAdapter[] = [
  new CursorAdapter(),
  new CopilotAdapter(),
  new GeminiAdapter(),
  new OpenCodeAdapter(),
];

/** Every new adapter accounts for every canonical field (§3, totality). */
export const MARKDOWN_ADAPTERS_COVER_ALL_FIELDS: boolean = MARKDOWN_ADAPTERS.every((adapter) =>
  CANONICAL_SKILL_FIELDS.every((field) =>
    adapter.capabilityTable.some((row) => row.field === field),
  ),
);
