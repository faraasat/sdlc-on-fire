import type { EvidenceEnvelope } from '@sdlc-on-fire/core';

/**
 * Pull-request body generation with the evidence bundle inline (P1-SKILL-02).
 *
 * The evidence bundle in the PR body is the product's claim made legible: a
 * reviewer sees which commands ran, against which commit, and what they said —
 * rather than a sentence asserting that everything passed.
 */

export interface PrEvidenceLine {
  readonly kind: string;
  readonly producer: string;
  readonly ok: boolean;
  readonly detail: string;
  readonly gitSha: string;
  readonly stale: boolean;
}

export interface PrBodyInput {
  readonly workItemId: string;
  readonly title: string;
  readonly summary: string;
  readonly acceptanceCriteria?: readonly string[] | undefined;
  readonly evidence: readonly EvidenceEnvelope[];
  readonly headSha: string;
  readonly gateVerdict?:
    { pass: boolean; missing: readonly string[]; failures: readonly string[] } | undefined;
}

function payloadOk(payload: unknown): boolean {
  return (
    typeof payload === 'object' && payload !== null && (payload as { ok?: unknown }).ok === true
  );
}

/** One line per envelope: what ran, who ran it, what it said, and whether it still applies. */
export function summariseEvidence(
  evidence: readonly EvidenceEnvelope[],
  headSha: string,
): PrEvidenceLine[] {
  return evidence.map((envelope) => {
    const payload = envelope.payload as Record<string, unknown> | null;
    // Narrowed to primitives before stringifying: a nested object would render
    // as "[object Object]" in the PR body, which reads as a bug to a reviewer.
    const scalar = (value: unknown): string =>
      typeof value === 'number' || typeof value === 'string' ? String(value) : '?';
    const detail =
      envelope.kind === 'test' && payload !== null
        ? `${scalar(payload['passed'])}/${scalar(payload['total'])} passed`
        : `exit ${scalar(envelope.command?.exit_code)}`;

    return {
      kind: envelope.kind,
      producer: envelope.producer,
      ok: payloadOk(envelope.payload),
      detail,
      gitSha: envelope.git_sha.slice(0, 7),
      // Surfaced rather than filtered: a reviewer should see that evidence exists
      // but no longer applies, which is different from no evidence at all.
      stale: envelope.git_sha !== headSha,
    };
  });
}

/**
 * Renders the PR body.
 *
 * `agent-claim` evidence is rendered but explicitly labelled non-gating — it can
 * inform a human reviewer while remaining structurally incapable of satisfying
 * the gate (ADR-0030).
 */
export function renderPrBody(input: PrBodyInput): string {
  const lines: string[] = [`## ${input.workItemId} — ${input.title}`, '', input.summary.trim(), ''];

  if (input.acceptanceCriteria !== undefined && input.acceptanceCriteria.length > 0) {
    lines.push('## Acceptance criteria', '');
    for (const criterion of input.acceptanceCriteria) lines.push(`- ${criterion}`);
    lines.push('');
  }

  lines.push('## Evidence', '');
  if (input.evidence.length === 0) {
    lines.push('_No evidence recorded._ This change has not been verified.', '');
  } else {
    lines.push('| Check | Producer | Result | Detail | Commit |', '|---|---|---|---|---|');
    for (const line of summariseEvidence(input.evidence, input.headSha)) {
      const producer =
        line.producer === 'agent-claim' ? '`agent-claim` (non-gating)' : `\`${line.producer}\``;
      const result = line.stale ? '⚠️ stale' : line.ok ? '✅ pass' : '❌ fail';
      lines.push(
        `| ${line.kind} | ${producer} | ${result} | ${line.detail} | \`${line.gitSha}\` |`,
      );
    }
    lines.push('');
  }

  if (input.gateVerdict !== undefined) {
    lines.push('## Gate', '');
    if (input.gateVerdict.pass) {
      lines.push('✅ Gate passed.', '');
    } else {
      lines.push('❌ Gate did not pass.', '');
      // "Run the check" and "fix the code" are different asks, so they render as
      // different sections rather than one blended list.
      if (input.gateVerdict.missing.length > 0) {
        lines.push(`**Missing** (run these): ${input.gateVerdict.missing.join(', ')}`, '');
      }
      if (input.gateVerdict.failures.length > 0) {
        lines.push(`**Failing** (fix these): ${input.gateVerdict.failures.join(', ')}`, '');
      }
    }
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

/** Conventional-commit PR title, scoped to the work item for `git log --grep`. */
export function renderPrTitle(workItemId: string, title: string, type = 'feat'): string {
  return `${type}(${workItemId}): ${title}`;
}
