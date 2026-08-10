import fs from 'node:fs/promises';
import path from 'node:path';
import type { CanonicalSkill } from '@sdlc-on-fire/core';
import {
  CANONICAL_SKILLS,
  ClaudeCodeAdapter,
  formatDoctorReport,
  runDoctor,
  type AgentAdapter,
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
}

/** Every canonical skill, in a stable order so output diffs are readable. */
function allSkills(sources: SkillSources = {}): readonly CanonicalSkill[] {
  const skills = sources.skills ?? Object.values(CANONICAL_SKILLS);
  return [...skills].sort((a, b) => a.name.localeCompare(b.name));
}

function allAdapters(sources: SkillSources = {}): readonly AgentAdapter[] {
  return sources.adapters ?? [new ClaudeCodeAdapter()];
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
 * Compiles every canonical skill to the Claude Code surface.
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

  for (const skill of skills) {
    const result = adapter.compileSkill(skill);
    for (const warning of result.warnings) {
      warnings.push(`${skill.name}: ${warning.message}`);
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
