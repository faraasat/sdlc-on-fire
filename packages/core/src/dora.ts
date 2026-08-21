/**
 * DORA's five metrics (P3-MET-02, `.research/techniques/35` §C).
 *
 * Two things about this module are unusual, and both come from what this
 * product is.
 *
 * **The five are returned together or not at all.** DORA's own guidance is
 * explicit that these are a system rather than a scorecard, and warns against
 * "having one metric to rule them all", recommending metrics "with a healthy
 * amount of tension between them". That is normally advice. Here it is the
 * type: there is no function that returns deployment frequency on its own, so a
 * dashboard cannot accidentally render a throughput number with nothing beside
 * it. A rule you can follow is a rule you can forget.
 *
 * **The AI-era caveat is the reason it is enforced rather than suggested.**
 * Deployment frequency and change lead time become misleading once a large
 * share of commits are model-authored — they measure how fast code is produced,
 * and production is precisely what stops being the constraint. Failed-deployment
 * recovery time is the one that stays honest, because recovery speed does not
 * care who wrote the change. A product whose entire premise is agent-authored
 * code reporting "deployments up 300%" without a stability counter-signal would
 * be selling the exact illusion it exists to puncture.
 *
 * **Grouping note.** `.research/35` recorded recovery time under *stability*.
 * DORA's current guidance groups it under **throughput**, and names the second
 * axis **instability** rather than stability. Corrected here from the primary
 * source at build time, per ADR-0073.
 */

/** Throughput: how quickly change moves. Three metrics, per current guidance. */
export interface Throughput {
  /** Time from change authored to running in production, ms. */
  readonly changeLeadTimeMs: number | null;
  /** Deployments per day. */
  readonly deploymentFrequencyPerDay: number | null;
  /** Time to restore service after a failed deployment, ms. */
  readonly failedDeploymentRecoveryMs: number | null;
}

/** Instability: how often change goes wrong. Higher is worse on both. */
export interface Instability {
  /** Share of deployments causing a failure, 0..1. */
  readonly changeFailRate: number | null;
  /** Share of deployments that were unplanned work to fix a prior one, 0..1. */
  readonly deploymentReworkRate: number | null;
}

/**
 * The whole system. Both axes, always.
 *
 * There is deliberately no exported accessor for one axis alone.
 */
export interface DoraReport {
  readonly throughput: Throughput;
  readonly instability: Instability;
  readonly windowDays: number;
  readonly deployments: number;
  /** Metrics that could not be computed, and why — never rendered as zero. */
  readonly unavailable: readonly { readonly metric: string; readonly because: string }[];
}

export interface DeploymentEvent {
  /** ISO timestamp the change reached production. */
  readonly deployedAt: string;
  /** ISO timestamp the change was authored, for lead time. */
  readonly authoredAt?: string | null;
  /** Whether this deployment caused a failure. */
  readonly failed?: boolean;
  /** Whether this deployment existed only to fix a previous one. */
  readonly isRework?: boolean;
  /** ISO timestamp service was restored, when this one failed. */
  readonly recoveredAt?: string | null;
}

const parse = (iso: string | null | undefined): number | null => {
  if (iso === null || iso === undefined) return null;
  const value = Date.parse(iso);
  return Number.isNaN(value) ? null : value;
};

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Compute all five over a window.
 *
 * Every metric that cannot be computed comes back `null` **and** appears in
 * `unavailable` with a reason. Reporting an uncomputable metric as zero is the
 * failure this whole product exists to refuse: a change-fail rate of 0% because
 * nothing was recorded looks exactly like a change-fail rate of 0% because
 * nothing failed, and one of those is excellent news.
 */
export function doraReport(
  deployments: readonly DeploymentEvent[],
  windowDays: number,
): DoraReport {
  const unavailable: { metric: string; because: string }[] = [];

  if (deployments.length === 0) {
    for (const metric of [
      'changeLeadTimeMs',
      'deploymentFrequencyPerDay',
      'failedDeploymentRecoveryMs',
      'changeFailRate',
      'deploymentReworkRate',
    ]) {
      unavailable.push({ metric, because: 'no deployments recorded in this window' });
    }
    return {
      throughput: {
        changeLeadTimeMs: null,
        deploymentFrequencyPerDay: null,
        failedDeploymentRecoveryMs: null,
      },
      instability: { changeFailRate: null, deploymentReworkRate: null },
      windowDays,
      deployments: 0,
      unavailable,
    };
  }

  const leadTimes: number[] = [];
  for (const event of deployments) {
    const authored = parse(event.authoredAt);
    const deployed = parse(event.deployedAt);
    if (authored !== null && deployed !== null) leadTimes.push(Math.max(0, deployed - authored));
  }
  if (leadTimes.length === 0) {
    unavailable.push({
      metric: 'changeLeadTimeMs',
      because: 'no deployment recorded when its change was authored',
    });
  }

  const recoveries: number[] = [];
  const failures = deployments.filter((event) => event.failed === true);
  for (const event of failures) {
    const deployed = parse(event.deployedAt);
    const recovered = parse(event.recoveredAt);
    if (deployed !== null && recovered !== null) recoveries.push(Math.max(0, recovered - deployed));
  }
  if (failures.length > 0 && recoveries.length === 0) {
    unavailable.push({
      metric: 'failedDeploymentRecoveryMs',
      because: 'deployments failed but none recorded when service was restored',
    });
  } else if (failures.length === 0) {
    unavailable.push({
      metric: 'failedDeploymentRecoveryMs',
      because: 'nothing failed in this window, so there is nothing to recover from',
    });
  }

  return {
    throughput: {
      changeLeadTimeMs: mean(leadTimes),
      deploymentFrequencyPerDay: windowDays <= 0 ? null : deployments.length / windowDays,
      failedDeploymentRecoveryMs: mean(recoveries),
    },
    instability: {
      changeFailRate: failures.length / deployments.length,
      deploymentReworkRate:
        deployments.filter((event) => event.isRework === true).length / deployments.length,
    },
    windowDays,
    deployments: deployments.length,
    unavailable,
  };
}

/** Metrics that stop meaning what they appear to mean when a model writes the code. */
export const AI_ERA_UNRELIABLE: readonly string[] = [
  'changeLeadTimeMs',
  'deploymentFrequencyPerDay',
];

/**
 * The caveat, attached to the numbers rather than filed in a doc.
 *
 * Returned as text a dashboard must render next to the throughput figures. A
 * caveat that lives in a design document is a caveat nobody reading the number
 * will ever see.
 */
export function aiEraCaveat(report: DoraReport): string | null {
  const throughputPresent =
    report.throughput.changeLeadTimeMs !== null ||
    report.throughput.deploymentFrequencyPerDay !== null;
  if (!throughputPresent) return null;

  return (
    'Change lead time and deployment frequency measure how fast change is produced, ' +
    'and production is the part a coding model changes most. Read them against the ' +
    'instability figures beside them; failed-deployment recovery time is the one that ' +
    'holds up regardless of who wrote the change.'
  );
}

/**
 * Render the system. Both axes or nothing.
 *
 * Refuses to format a report that has throughput and no instability at all —
 * the one shape DORA's guidance and the AI-era caveat both say must never be
 * presented.
 */
export function formatDora(report: DoraReport): string {
  const ms = (value: number | null): string =>
    value === null ? 'not available' : `${(value / 3_600_000).toFixed(1)}h`;
  const pct = (value: number | null): string =>
    value === null ? 'not available' : `${(value * 100).toFixed(1)}%`;

  const lines = [
    `DORA over ${String(report.windowDays)} day(s), ${String(report.deployments)} deployment(s)`,
    '',
    'Throughput',
    `  change lead time                ${ms(report.throughput.changeLeadTimeMs)}`,
    `  deployment frequency            ${
      report.throughput.deploymentFrequencyPerDay === null
        ? 'not available'
        : `${report.throughput.deploymentFrequencyPerDay.toFixed(2)}/day`
    }`,
    `  failed-deployment recovery      ${ms(report.throughput.failedDeploymentRecoveryMs)}`,
    '',
    'Instability',
    `  change fail rate                ${pct(report.instability.changeFailRate)}`,
    `  deployment rework rate          ${pct(report.instability.deploymentReworkRate)}`,
  ];

  if (report.unavailable.length > 0) {
    lines.push('', 'Not computed:');
    // Listed, never rendered as zero. "0% because nothing was recorded" and
    // "0% because nothing failed" look identical and one of them is good news.
    for (const entry of report.unavailable) lines.push(`  ${entry.metric} — ${entry.because}`);
  }

  const caveat = aiEraCaveat(report);
  if (caveat !== null) lines.push('', caveat);

  return lines.join('\n');
}
