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
