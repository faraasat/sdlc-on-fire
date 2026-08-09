import type { CanonicalSkill } from '@sdlc-on-fire/core';

/**
 * The `AgentAdapter` port, per contracts/04-skill-ir.md §3 and ADR-0007.
 *
 * Ports and adapters (architecture §4a): this file defines the boundary, each
 * target is an adapter plugged in at the edge, and **nothing here imports a
 * concrete adapter's types**. If a Claude-specific or Codex-specific type ever
 * appears in this file, the abstraction has already failed.
 */

export interface CompiledFile {
  /** Relative to project root, e.g. `.claude/skills/implement/SKILL.md`. */
  readonly path: string;
  readonly content: string;
  /** `merge` is only legal for override-layer targets. */
  readonly mode?: 'create' | 'overwrite' | 'merge' | undefined;
}

export const COMPILE_SEVERITIES = ['info', 'warning', 'error'] as const;
export type CompileSeverity = (typeof COMPILE_SEVERITIES)[number];

export interface CompileWarning {
  /** Canonical field name, e.g. `hooks`. */
  readonly field: string;
  /** Adapter id, e.g. `claude-code`. */
  readonly target: string;
  readonly severity: CompileSeverity;
  /** e.g. "no Codex equivalent; dropped". */
  readonly message: string;
}

export interface CompileResult {
  readonly files: readonly CompiledFile[];
  readonly warnings: readonly CompileWarning[];
}

/** How one adapter handles one canonical field, at a given schema version. */
export interface CapabilityRow {
  readonly field: string;
  readonly support: 'mapped' | 'passthrough' | 'dropped';
  /** Native field this maps onto, when `mapped` or `passthrough`. */
  readonly nativeField?: string | undefined;
  readonly note?: string | undefined;
}

export interface DetectionReport {
  readonly target: string;
  readonly present: boolean;
  /** Evidence for the verdict — paths found, versions read. Never a bare boolean. */
  readonly findings: readonly string[];
}

export interface AgentAdapter {
  readonly id: string;
  /** Version-gated field-support table (§5.1). Drives `doctor` and totality checks. */
  readonly capabilityTable: readonly CapabilityRow[];
  /** Highest canonical `schema_version` this adapter understands. */
  readonly maxSchemaVersion: string;

  compileSkill(skill: CanonicalSkill): CompileResult;

  /**
   * Reporting only — never silent auto-targeting at generate time. Targets are
   * explicitly configured per project, never sniffed (ADR-0007).
   */
  detect(projectRoot: string): Promise<DetectionReport>;
}

/** Every canonical field an adapter's capability table must account for (§3, totality). */
export const CANONICAL_SKILL_FIELDS = [
  'schema_version',
  'name',
  'description',
  'stage',
  'tier',
  'context_pack_spec_ref',
  'role',
  'constitution_excerpt_ref',
  'task',
  'output_contract',
  'self_verification',
  'stop_condition',
  'verify',
  'arguments',
  'paths',
  'allowed_tools',
  'disallowed_tools',
  'context_mode',
  'deprecation',
  'hooks',
] as const;

/**
 * Which canonical fields an adapter fails to account for.
 *
 * The contract's **totality** requirement: every field is mapped, passed
 * through, or explicitly dropped-with-warning. Silently ignoring a field is the
 * failure this catches — an adapter that forgets `allowed_tools` would quietly
 * compile away a security boundary.
 */
export function missingCapabilityRows(adapter: AgentAdapter): string[] {
  const covered = new Set(adapter.capabilityTable.map((row) => row.field));
  return CANONICAL_SKILL_FIELDS.filter((field) => !covered.has(field));
}

/** Compares dotted semver numerically, so `0.10.0` sorts above `0.9.0`. */
export function compareSemver(a: string, b: string): number {
  const parse = (value: string): number[] =>
    (value.split('-')[0] ?? '').split('.').map((part) => Number.parseInt(part, 10) || 0);
  const [left, right] = [parse(a), parse(b)];
  for (let index = 0; index < 3; index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Whether an adapter can compile a skill at all.
 *
 * A skill declaring a schema version beyond what the adapter understands is an
 * error, not a warning: the adapter would be guessing at fields it has never
 * seen, and a guess that compiles is worse than a refusal (contract §3).
 */
export function supportsSchemaVersion(adapter: AgentAdapter, skill: CanonicalSkill): boolean {
  return compareSemver(skill.schema_version, adapter.maxSchemaVersion) <= 0;
}
