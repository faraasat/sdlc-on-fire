import fs from 'node:fs/promises';
import path from 'node:path';
import {
  evaluatePilot,
  formatPilotVerdict,
  PILOT_CRITERIA,
  resolveWorkspaceLayout,
  type PilotReport,
  type PilotVerdict,
} from '@sdlc-on-fire/core';

/**
 * `sdlc pilot` — the external-pilot release gate (P2-QA-07, ADR-0064).
 *
 * `template` writes a report skeleton; `check` judges a filled-in one and exits
 * non-zero until the gate is met. The skeleton, like the research skeleton in
 * `sdlc research new`, **does not pass its own check** — it has no measurements
 * and says so. A template whose output satisfies the gate has produced a pass.
 *
 * The report is a file in the workspace, because the thing being gated is a
 * public release and the evidence for it should be reviewable in a diff by
 * somebody who was not on the pilot.
 */

export const PILOT_REPORT = 'pilot-report.json';

const reportPath = (root: string): string =>
  path.join(resolveWorkspaceLayout(root).root, PILOT_REPORT);

export interface PilotCheckResult {
  readonly report: string;
  readonly verdict: PilotVerdict;
  readonly ok: boolean;
}

export async function checkPilot(root: string): Promise<PilotCheckResult> {
  const raw = await fs.readFile(reportPath(root), 'utf8').catch(() => null);
  if (raw === null) {
    // Absent is a refusal, not an absence of opinion: no pilot report means the
    // pilot has not happened, and the release it gates stays blocked.
    return {
      report: PILOT_REPORT,
      verdict: {
        met: [],
        findings: [
          {
            criterion: 'pilot',
            message: `no ${PILOT_REPORT} — the pilot has not happened, so the release it gates stays blocked (ADR-0064)`,
          },
        ],
        ok: false,
      },
      ok: false,
    };
  }

  const parsed = JSON.parse(raw) as PilotReport;
  const verdict = evaluatePilot(parsed);
  return { report: PILOT_REPORT, verdict, ok: verdict.ok };
}

export interface PilotTemplateResult {
  readonly path: string;
  readonly created: boolean;
}

export async function writePilotTemplate(root: string): Promise<PilotTemplateResult> {
  const full = reportPath(root);
  const skeleton = {
    repository: '',
    maintainer: '',
    observations: PILOT_CRITERIA.map((criterion) => ({
      criterion,
      // `assertion` on purpose. The skeleton must fail its own check: a
      // template whose output satisfies the gate has produced a pass.
      kind: 'assertion',
      detail: 'replace with the command that was run and what it printed',
      atCommit: '',
    })),
    friction: [] as { summary: string; workItemId?: string }[],
  };

  try {
    await fs.writeFile(full, `${JSON.stringify(skeleton, null, 2)}\n`, { flag: 'wx' });
    return { path: PILOT_REPORT, created: true };
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'EEXIST') {
      // Never overwritten. It may already hold a real pilot's evidence.
      return { path: PILOT_REPORT, created: false };
    }
    throw cause;
  }
}

export function formatPilotCheck(result: PilotCheckResult, report?: PilotReport): string {
  return formatPilotVerdict(
    report ?? { repository: '', maintainer: '', observations: [], friction: [] },
    result.verdict,
  );
}
