import fs from 'node:fs/promises';
import path from 'node:path';
import type { CanonicalSkill } from '@sdlc-on-fire/core';
import { overriddenSkills } from './prompts.js';
import {
  CANONICAL_SKILLS,
  ClaudeCodeAdapter,
  formatDoctorReport,
  CopilotAdapter,
  CodexAdapter,
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
  /** Local overlays that changed something, and what they changed. */
  readonly overrides: readonly { readonly skill: string; readonly applied: readonly string[] }[];
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
  // P8-CODEX-01. Registered as its own target rather than left to the OpenCode
  // adapter's `AGENTS.md`, which reached Codex by coincidence: no capability
  // table said what Codex drops, and `agents doctor` could not report it.
  codex: () => new CodexAdapter(),
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

/**
 * `sdlc skills targets` — which agent surfaces this project actually has
 * (P8-CODEX-01).
 *
 * **This exists because `AgentAdapter.detect()` had no caller.** Every adapter
 * since P0-AGENT-01 implemented it — Claude Code, MCP, Cursor, Copilot, Gemini,
 * OpenCode — and a repo-wide search found the only `.detect(` call in the
 * *importer* port. Seven implementations, tested, documented, and unreachable:
 * the read-path-with-no-writer shape inverted, and adding Codex as an eighth
 * without a reader would have been the wrong way to close ADR-0063's
 * requirement that the doctor can see Codex.
 *
 * Reporting only, and the ordering never becomes selection ([ADR-0007]). A
 * compiler that picked its target by looking at the tree would write to
 * whichever surface happened to be lying around.
 */
export interface TargetPresence {
  readonly target: string;
  readonly present: boolean;
  readonly findings: readonly string[];
}

export async function detectTargets(root: string): Promise<readonly TargetPresence[]> {
  const reports = await Promise.all(
    Object.entries(COMPILE_TARGETS).map(async ([name, build]) => {
      const report = await build().detect(root);
      return { target: name, present: report.present, findings: report.findings };
    }),
  );
  return [...reports].sort((a, b) => a.target.localeCompare(b.target));
}

export function formatTargets(reports: readonly TargetPresence[]): string {
  const present = reports.filter((report) => report.present);
  const lines = reports.map(
    (report) =>
      `  ${report.present ? '✓' : '·'} ${report.target.padEnd(12)} ${
        report.findings.length === 0 ? 'no sign of it here' : report.findings.join(', ')
      }`,
  );
  return [
    `${String(present.length)} of ${String(reports.length)} target(s) look present in this project`,
    '',
    ...lines,
    '',
    'Reporting only. `skills compile --target <name>` is always an explicit choice —',
    'a compiler that picked its own target would write to whatever was lying around.',
  ].join('\n');
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
  // Overlaid once, here, before anything compiles — so no adapter has to know
  // local overrides exist and none of them can forget to apply one
  // (P6-SURFACE-08, FEAT-AGT-009).
  const reports = await overriddenSkills(root, allSkills(options));
  const skills = reports.map((report) => report.skill);
  const doctor = runDoctor({ skills, adapters });

  if (!doctor.ok) {
    throw new Error(
      `refusing to compile — the pre-compile check found errors:\n${formatDoctorReport(doctor)}`,
    );
  }

  const files: CompiledSkillFile[] = [];
  // A refused override is a warning, not a failure. One stale override file
  // must not stop every skill from compiling — that is the shape of check
  // people delete.
  const warnings: string[] = reports.flatMap((report) =>
    report.refusals.map((refusal) => `${report.name}: ${refusal}`),
  );
  const overrides = reports
    .filter((report) => report.applied.length > 0)
    .map((report) => ({ skill: report.name, applied: report.applied }));

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

  return {
    target: adapter.id,
    skills: skills.map((s) => s.name),
    files,
    warnings,
    doctor,
    overrides,
  };
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
