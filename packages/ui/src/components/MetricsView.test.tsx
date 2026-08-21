// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MetricsView } from './MetricsView.js';

/**
 * P3-KAN-04 — the dashboard.
 *
 * What matters here is what the charts refuse to draw. A dashboard's failure
 * mode is not a wrong pixel, it is a plausible picture of data that does not
 * exist — an empty gate axis that reads as "all passing", or a trend line drawn
 * through one point.
 */

const payload = {
  windowDays: 30,
  stages: [{ stage: 'implement', totalMs: 7_200_000, visits: 2, meanMs: 3_600_000 }],
  bottleneck: { stage: 'implement', totalMs: 7_200_000 },
  flowEfficiency: { activeMs: 7_200_000, waitMs: 3_600_000, ratio: 2 / 3 },
  rework: { cardsWithRework: 1, totalRevisits: 2, hotspots: [{ stage: 'implement', revisits: 2 }] },
  cycleTimes: [{ id: 'FEAT-1', cycleTimeMs: 7_200_000 }],
  cumulative: { implement: 3, done: 1 },
  gates: [{ gate: 'build', result: 'pass', count: 4 }],
  runs: [{ status: 'pass', count: 4 }],
};

function stub(body: unknown = payload, status = 200): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status }))),
  );
}

function renderMetrics(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MetricsView />
    </QueryClientProvider>,
  );
}

beforeEach(() => stub());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('MetricsView', () => {
  it('names the binding constraint', async () => {
    // Theory of Constraints' one useful claim, made actionable: optimising
    // anywhere else does not move throughput.
    renderMetrics();
    expect(await screen.findByText(/binding constraint/i)).toBeDefined();
    expect(screen.getAllByText(/implement/i).length).toBeGreaterThan(0);
  });

  it('says no gate has run rather than drawing an empty axis', async () => {
    // An empty chart reads as "all passing", which is the exact claim this
    // product exists to refuse.
    stub({ ...payload, gates: [] });
    renderMetrics();
    expect(await screen.findByText(/this is not a pass/i)).toBeDefined();
  });

  it('labels the column snapshot as a snapshot, not a cumulative flow diagram', async () => {
    // Nothing records a daily series, and a trend drawn from one point is an
    // invention rather than a chart.
    renderMetrics();
    expect(await screen.findByText(/not a cumulative flow diagram/i)).toBeDefined();
  });

  it('distinguishes no history from bad flow', async () => {
    // "Nothing has moved" and "flow efficiency is 0%" are different problems,
    // and the first is not a problem at all.
    stub({
      ...payload,
      stages: [],
      bottleneck: null,
      flowEfficiency: { activeMs: 0, waitMs: 0, ratio: null },
    });
    renderMetrics();
    expect(await screen.findByText(/nothing has moved yet/i)).toBeDefined();
  });

  it('shows flow efficiency as not available rather than as zero', async () => {
    stub({ ...payload, flowEfficiency: { activeMs: 0, waitMs: 0, ratio: null } });
    renderMetrics();
    expect(await screen.findByText('not available')).toBeDefined();
  });

  it('reports rework hotspots', async () => {
    renderMetrics();
    expect(await screen.findByText(/most returned to/i)).toBeDefined();
  });

  it('surfaces an unreachable daemon instead of an empty dashboard', async () => {
    stub({}, 503);
    renderMetrics();
    expect((await screen.findByRole('alert')).textContent).toContain('503');
  });
});
