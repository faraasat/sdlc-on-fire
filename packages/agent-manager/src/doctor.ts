import type { CanonicalSkill } from '@sdlc-on-fire/core';
import {
  missingCapabilityRows,
  supportsSchemaVersion,
  type AgentAdapter,
  type CompileWarning,
} from './port.js';

/**
 * `sdlc agents doctor` — the pre-compile check.
 *
 * Its job is to make every gap between the canonical source and a target
 * *visible* before compilation writes anything. A silently dropped field is the
 * failure this exists to prevent: `allowed_tools` vanishing on one target would
 * be a security boundary quietly removed.
 */

/**
 * Fields the doctor reports directly, so the generic `dropped` notice stays
 * quiet about them. `deprecation` is doctor-only by design — it never reaches an
 * agent surface — and saying so twice per adapter buries the retirement notice.
 */
const DOCTOR_OWNED_FIELDS = new Set<string>(['deprecation']);

export interface DoctorFinding extends CompileWarning {
  readonly skill?: string | undefined;
}

export interface DoctorReport {
  readonly findings: readonly DoctorFinding[];
  /** True when no finding is `error`-severity. Warnings do not block. */
  readonly ok: boolean;
}

export interface DoctorInput {
  readonly skills: readonly CanonicalSkill[];
  readonly adapters: readonly AgentAdapter[];
}

/**
 * Runs every skill against every configured adapter.
 *
 * Compilation is attempted rather than simulated, so the report reflects what
 * would actually be written — a doctor that checks a different code path from
 * the compiler is a doctor that can pass while the compiler fails.
 */
export function runDoctor(input: DoctorInput): DoctorReport {
  const findings: DoctorFinding[] = [];

  // Deprecation is a property of the skill, not of any target, so it is checked
  // once per skill rather than once per (skill, adapter) pair — otherwise a
  // three-adapter setup reports the same retirement three times and operators
  // learn to skim past it.
  for (const skill of input.skills) {
    findings.push(...deprecationFindings(skill));
  }

  for (const adapter of input.adapters) {
    // A missing capability row is an adapter defect, not a skill defect, so it
    // is reported once per adapter rather than once per skill.
    for (const field of missingCapabilityRows(adapter)) {
      findings.push({
        field,
        target: adapter.id,
        severity: 'error',
        message: `adapter "${adapter.id}" has no capability row for canonical field "${field}"`,
      });
    }

    for (const skill of input.skills) {
      if (!supportsSchemaVersion(adapter, skill)) {
        findings.push({
          skill: skill.name,
          field: 'schema_version',
          target: adapter.id,
          severity: 'error',
          message:
            `skill "${skill.name}" declares schema_version ${skill.schema_version}, ` +
            `beyond adapter "${adapter.id}" max ${adapter.maxSchemaVersion}. ` +
            'Refusing rather than guessing at fields this adapter has never seen.',
        });
        // Do not attempt to compile a skill the adapter cannot understand.
        continue;
      }

      // Surface dropped fields the skill actually sets — a `dropped` row for a
      // field nobody uses is noise, but one for a field in use is information.
      for (const row of adapter.capabilityTable) {
        if (row.support !== 'dropped') continue;
        // Except fields the doctor already reports itself, and better: two
        // findings about one fact is how a report stops being read.
        if (DOCTOR_OWNED_FIELDS.has(row.field)) continue;
        const value = (skill as unknown as Record<string, unknown>)[row.field];
        if (value === undefined) continue;
        findings.push({
          skill: skill.name,
          field: row.field,
          target: adapter.id,
          severity: 'info',
          message: `"${row.field}" is set but dropped for ${adapter.id}${row.note === undefined ? '' : ` (${row.note})`}`,
        });
      }

      for (const warning of adapter.compileSkill(skill).warnings) {
        findings.push({ ...warning, skill: skill.name });
      }
    }
  }

  return { findings, ok: !findings.some((finding) => finding.severity === 'error') };
}

/**
 * Turns tiered deprecation metadata into findings (P0-AGENT-05, ADR-0034).
 *
 * The tiers escalate on purpose: `warn` says a replacement exists, `error`
 * blocks, and `removed` reports a skill that should no longer be present at all.
 * Severity is read from the declared tier rather than inferred from dates —
 * a date-driven rule would change a build's outcome with no commit behind it.
 */
function deprecationFindings(skill: CanonicalSkill): DoctorFinding[] {
  const deprecation = skill.deprecation;
  if (deprecation === undefined) return [];

  const replacement =
    deprecation.replacement_ref === undefined
      ? ' No replacement is declared, so callers have nowhere to go — that is itself a defect.'
      : ` Use "${deprecation.replacement_ref}" instead.`;

  const severity = deprecation.removal_tier === 'warn' ? ('warning' as const) : ('error' as const);

  const what =
    deprecation.removal_tier === 'removed'
      ? 'was removed and must not be compiled or dispatched'
      : deprecation.removal_tier === 'error'
        ? 'is deprecated past the point of use'
        : 'is deprecated';

  return [
    {
      skill: skill.name,
      field: 'deprecation',
      target: 'canonical',
      severity,
      message: `skill "${skill.name}" ${what} (since ${deprecation.deprecated_since}).${replacement}`,
    },
  ];
}

/** Human-readable report. `--json` callers use {@link runDoctor} directly. */
export function formatDoctorReport(report: DoctorReport): string {
  if (report.findings.length === 0) return 'agents doctor: OK — no findings.';

  const lines = report.findings.map((finding) => {
    const where =
      finding.skill === undefined ? finding.target : `${finding.target}/${finding.skill}`;
    return `  [${finding.severity}] ${where} · ${finding.field}: ${finding.message}`;
  });

  return [`agents doctor: ${report.ok ? 'OK with findings' : 'FAILED'}`, ...lines].join('\n');
}
