import { describe, expect, it } from 'vitest';
import {
  AI_ERA_UNRELIABLE,
  aiEraCaveat,
  doraReport,
  formatDora,
  type DeploymentEvent,
} from './dora.js';

/**
 * P3-MET-02 — DORA's five, as a system.
 *
 * The property under test is that this module cannot be used to present a
 * throughput number on its own. DORA's guidance says the five are a system
 * rather than a scorecard, and the 2026 caveat is sharper still for this
 * product: deployment frequency and lead time measure how fast code is
 * *produced*, which is exactly what stops being the constraint once a model
 * writes it.
 */

const HOUR = 3_600_000;
const at = (hours: number): string => new Date(Date.UTC(2026, 7, 1, hours)).toISOString();

const deploy = (over: Partial<DeploymentEvent> = {}): DeploymentEvent => ({
  deployedAt: at(4),
  authoredAt: at(0),
  ...over,
});

describe('doraReport', () => {
  it('reports both axes together', () => {
    const report = doraReport([deploy(), deploy({ failed: true, recoveredAt: at(5) })], 1);
    expect(report.throughput.changeLeadTimeMs).toBe(4 * HOUR);
    expect(report.throughput.deploymentFrequencyPerDay).toBe(2);
    expect(report.instability.changeFailRate).toBe(0.5);
  });

  it('computes recovery time only from deployments that failed', () => {
    const report = doraReport([deploy(), deploy({ failed: true, recoveredAt: at(6) })], 1);
    expect(report.throughput.failedDeploymentRecoveryMs).toBe(2 * HOUR);
  });

  it('never reports an uncomputable metric as zero', () => {
    // The failure this whole product exists to refuse. "0% because nothing was
    // recorded" and "0% because nothing failed" look identical, and one of them
    // is excellent news.
    const report = doraReport([], 7);
    expect(report.instability.changeFailRate).toBeNull();
    expect(report.throughput.deploymentFrequencyPerDay).toBeNull();
    expect(report.unavailable.map((entry) => entry.metric)).toContain('changeFailRate');
  });

  it('says why a metric is missing, per metric', () => {
    const report = doraReport([deploy({ authoredAt: null })], 1);
    const missing = report.unavailable.find((entry) => entry.metric === 'changeLeadTimeMs');
    expect(missing?.because).toContain('authored');
  });

  it('distinguishes "nothing failed" from "we did not record the recovery"', () => {
    // Opposite meanings. One is a healthy window; the other is missing
    // instrumentation that makes the window unreadable.
    const clean = doraReport([deploy()], 1);
    expect(
      clean.unavailable.find((entry) => entry.metric === 'failedDeploymentRecoveryMs')?.because,
    ).toContain('nothing failed');

    const unrecorded = doraReport([deploy({ failed: true })], 1);
    expect(
      unrecorded.unavailable.find((entry) => entry.metric === 'failedDeploymentRecoveryMs')
        ?.because,
    ).toContain('none recorded');
  });

  it('computes the rework rate separately from the fail rate', () => {
    // A deployment that exists only to fix a previous one is not itself a
    // failure; conflating them double-counts one incident.
    const report = doraReport([deploy(), deploy({ isRework: true })], 1);
    expect(report.instability.deploymentReworkRate).toBe(0.5);
    expect(report.instability.changeFailRate).toBe(0);
  });

  it('refuses to divide by a zero-length window', () => {
    expect(doraReport([deploy()], 0).throughput.deploymentFrequencyPerDay).toBeNull();
  });
});

describe('the AI-era caveat', () => {
  it('names the two metrics that stop meaning what they appear to', () => {
    expect(AI_ERA_UNRELIABLE).toContain('deploymentFrequencyPerDay');
    expect(AI_ERA_UNRELIABLE).toContain('changeLeadTimeMs');
    // Recovery time is not on the list: it measures how fast service is
    // restored, which does not care who wrote the change.
    expect(AI_ERA_UNRELIABLE).not.toContain('failedDeploymentRecoveryMs');
  });

  it('attaches to any report that has a throughput number', () => {
    // A caveat living in a design document is one nobody reading the number
    // will ever see.
    expect(aiEraCaveat(doraReport([deploy()], 1))).toContain('produced');
  });

  it('says nothing when there is no throughput figure to qualify', () => {
    expect(aiEraCaveat(doraReport([], 7))).toBeNull();
  });
});

describe('formatDora', () => {
  it('always prints both axes', () => {
    // The structural half: there is no accessor that returns throughput alone,
    // so a dashboard cannot render one without the other.
    const text = formatDora(
      doraReport([deploy(), deploy({ failed: true, recoveredAt: at(5) })], 1),
    );
    expect(text).toContain('Throughput');
    expect(text).toContain('Instability');
    expect(text).toContain('change fail rate');
  });

  it('prints the caveat next to the numbers', () => {
    expect(formatDora(doraReport([deploy()], 1))).toContain('who wrote the change');
  });

  it('lists what was not computed rather than showing it as a number', () => {
    const text = formatDora(doraReport([], 7));
    expect(text).toContain('Not computed');
    expect(text).toContain('not available');
    expect(text).not.toMatch(/change fail rate\s+0\.0%/);
  });

  it('groups recovery time under throughput, per current DORA guidance', () => {
    // `.research/35` filed it under stability. DORA's own docs group it under
    // throughput and call the second axis *instability* — corrected from the
    // primary source at build time (ADR-0073).
    const text = formatDora(doraReport([deploy({ failed: true, recoveredAt: at(5) })], 1));
    const throughputAt = text.indexOf('Throughput');
    const instabilityAt = text.indexOf('Instability');
    const recoveryAt = text.indexOf('failed-deployment recovery');
    expect(recoveryAt).toBeGreaterThan(throughputAt);
    expect(recoveryAt).toBeLessThan(instabilityAt);
  });
});
