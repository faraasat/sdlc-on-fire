import fs from 'node:fs/promises';
import path from 'node:path';
import type { CanonicalSkill } from '@sdlc-on-fire/core';
import {
  CANONICAL_SKILLS,
  ClaudeCodeAdapter,
  formatDoctorReport,
  CopilotAdapter,
  CursorAdapter,
  GeminiAdapter,
  McpAdapter,
  OpenCodeAdapter,
  runDoctor,
  type AgentAdapter,
  type CompileResult,
  type DoctorReport,
} from '@sdlc-on-fire/agent-manager';

/**
 * `sdlc skills compile` and `sdlc skills doctor` (P0-AGENT-02, contract 04).
 *
 * The compiler, the capability table and `runDoctor` all shipped with
 * P0-AGENT-02 and were covered by tests — but nothing ever wired them to a
 * command, so a user could not compile a skill or run the doctor at all. The
 * [v0.1 definition of done](docs/.plan/mvp-slice.md) names exactly this ("one
 * canonical skill compiles to Claude Code SKILL.md and `agents doctor` passes"),
 * and it was unreachable from the binary. Found by walking the DoD by hand;
 * every unit test passed throughout, because each tested the library directly.
 *
 * **The doctor runs before the compiler writes anything.** A dropped field is
 * the failure being guarded against — `allowed_tools` vanishing on a target is a
 * security boundary quietly removed — and discovering that after the file is on
 * disk means the bad file is already what the agent surface reads.
 */

export interface CompiledSkillFile {
  readonly path: string;
  readonly bytes: number;
  /** False when the file on disk already had exactly this content. */
  readonly changed: boolean;
}

export interface CompileSkillsResult {
  readonly target: string;
  readonly skills: readonly string[];
  readonly files: readonly CompiledSkillFile[];
  readonly warnings: readonly string[];
  readonly doctor: DoctorReport;
}

/**
 * What to compile and where to.
 *
 * Injectable so a test can drive a target that genuinely fails the pre-compile
 * check. Without a seam, the "refuse rather than write" branch is only
 * reachable by shipping a broken adapter, which is to say never tested — and an
 * untested refusal is one nobody finds out is broken until it silently writes.
 */
export interface SkillSources {
  readonly skills?: readonly CanonicalSkill[] | undefined;
  readonly adapters?: readonly AgentAdapter[] | undefined;
  /** Which configured target to compile to. Never sniffed from the tree (ADR-0007). */
  readonly target?: string | undefined;
}

/**
 * The targets this build can compile to.
 *
 * Explicit, and selected by name rather than detected. `detect()` exists for
 * reporting only — a compiler that picks its target by looking at the working
 * tree writes to whichever surface happens to be lying around, which is how a
 * compiled artifact ends up somewhere nobody chose.
 */
export const COMPILE_TARGETS: Readonly<Record<string, () => AgentAdapter>> = {
  'claude-code': () => new ClaudeCodeAdapter(),
  mcp: () => new McpAdapter(),
  // P5-ADAPT-01. Registered here rather than discovered, for the reason above:
  // a target list assembled by looking around writes to whichever surface
  // happens to be lying around.
  cursor: () => new CursorAdapter(),
  copilot: () => new CopilotAdapter(),
  gemini: () => new GeminiAdapter(),
  opencode: () => new OpenCodeAdapter(),
};

/** Every canonical skill, in a stable order so output diffs are readable. */
function allSkills(sources: SkillSources = {}): readonly CanonicalSkill[] {
  const skills = sources.skills ?? Object.values(CANONICAL_SKILLS);
  return [...skills].sort((a, b) => a.name.localeCompare(b.name));
}

function allAdapters(sources: SkillSources = {}): readonly AgentAdapter[] {
  if (sources.adapters !== undefined) return sources.adapters;
  if (sources.target === undefined) return [new ClaudeCodeAdapter()];

  const build = COMPILE_TARGETS[sources.target];
  if (build === undefined) {
    // Named rather than silently defaulted. A typo'd target that quietly
    // compiles to Claude Code reports success and writes to the wrong surface.
    throw new Error(
      `unknown target "${sources.target}" — configured targets are ${Object.keys(COMPILE_TARGETS).join(', ')}`,
    );
  }
  return [build()];
}

/** Runs the pre-compile check without writing anything. */
export function doctorSkills(sources: SkillSources = {}): DoctorReport {
  return runDoctor({ skills: allSkills(sources), adapters: allAdapters(sources) });
}

export function formatDoctor(report: DoctorReport): string {
  const body = formatDoctorReport(report);
  return body.trim() === ''
    ? `agents doctor: OK — ${String(allSkills().length)} skill(s), no findings`
    : body;
}

const isAdapter = (value: unknown): value is AgentAdapter =>
  typeof value === 'object' && value !== null && 'compileSkill' in value;

/**
 * Compiles every canonical skill to the configured surface.
 *
 * Refuses on an error-severity doctor finding rather than writing and warning.
 * A compiled surface that is wrong is worse than an absent one: the agent reads
 * it as authoritative, and nothing downstream re-checks it.
 */
export async function compileSkills(
  root: string,
  options: { readonly dryRun?: boolean | undefined } & SkillSources = {},
): Promise<CompileSkillsResult> {
  const adapters = allAdapters(options);
  const adapter = adapters[0];
  if (!isAdapter(adapter)) throw new Error('no agent surface configured to compile to');
  const skills = allSkills(options);
  const doctor = runDoctor({ skills, adapters });

  if (!doctor.ok) {
    throw new Error(
      `refusing to compile — the pre-compile check found errors:\n${formatDoctorReport(doctor)}`,
    );
  }

  const files: CompiledSkillFile[] = [];
  const warnings: string[] = [];

  // A target whose artifact is per-workspace compiles the set at once
  // (contract §3.1). Looping `compileSkill` for MCP would emit one tool file
  // per skill and no server — every tool present, and nothing to connect to.
  const results: { label: string | null; result: CompileResult }[] =
    adapter.compileServer === undefined
      ? skills.map((skill) => ({ label: skill.name, result: adapter.compileSkill(skill) }))
      : [{ label: null, result: adapter.compileServer(skills) }];

  for (const { label, result } of results) {
    for (const warning of result.warnings) {
      // A per-skill compile labels its warnings with the skill; a server
      // compile's already name the tool they are about.
      warnings.push(label === null ? warning.message : `${label}: ${warning.message}`);
    }
    for (const file of result.files) {
      const full = path.join(root, file.path);
      const existing = await fs.readFile(full, 'utf8').catch(() => null);
      const changed = existing !== file.content;
      if (changed && options.dryRun !== true) {
        await fs.mkdir(path.dirname(full), { recursive: true });
        await fs.writeFile(full, file.content, 'utf8');
      }
      files.push({ path: file.path, bytes: Buffer.byteLength(file.content), changed });
    }
  }

  return { target: adapter.id, skills: skills.map((s) => s.name), files, warnings, doctor };
}

export function formatCompile(result: CompileSkillsResult, dryRun: boolean): string {
  const lines = [
    `${dryRun ? 'would compile' : 'compiled'} ${String(result.skills.length)} skill(s) → ${result.target}`,
  ];
  for (const file of result.files) {
    lines.push(`  ${file.changed ? '✎' : '·'} ${file.path}  (${String(file.bytes)} bytes)`);
  }
  if (result.files.every((f) => !f.changed)) lines.push('  (already up to date)');
  for (const warning of result.warnings) lines.push(`  ⚠ ${warning}`);
  return lines.join('\n');
}
