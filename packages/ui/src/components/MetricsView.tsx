import { useMemo, type ReactElement } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

/**
 * The metrics dashboard (P3-KAN-04).
 *
 * Everything here is derived from what actually happened — lifecycle
 * transitions, gate results, run statuses — and nothing is estimated. Where a
 * chart cannot be drawn honestly it says so instead of drawing something
 * plausible: a cumulative flow diagram needs a daily snapshot series that
 * nothing in this product records yet, so what is shown is the *current*
 * distribution, labelled as that rather than rendered as a time series with one
 * point and an implied trend.
 */

interface MetricsPayload {
  readonly windowDays: number;
  readonly stages: readonly { stage: string; totalMs: number; visits: number; meanMs: number }[];
  readonly bottleneck: { stage: string; totalMs: number } | null;
  readonly flowEfficiency: { activeMs: number; waitMs: number; ratio: number | null };
  readonly rework: {
    cardsWithRework: number;
    totalRevisits: number;
    hotspots: { stage: string; revisits: number }[];
  };
  readonly cycleTimes: readonly { id: string; cycleTimeMs: number | null }[];
  readonly cumulative: Readonly<Record<string, number>>;
  readonly gates: readonly { gate: string; result: string; count: number }[];
  readonly runs: readonly { status: string; count: number }[];
}

const RESULT_COLOR: Readonly<Record<string, string>> = {
  pass: 'var(--ok)',
  fail: 'var(--bad)',
  pending: 'var(--warn)',
  running: 'var(--accent)',
  error: 'var(--bad)',
  unrecorded: 'var(--muted)',
};

const hours = (ms: number): number => Number((ms / 3_600_000).toFixed(2));

export function MetricsView(): ReactElement {
  const metrics = useQuery({
    queryKey: ['metrics'],
    queryFn: async (): Promise<MetricsPayload> => {
      const response = await fetch('/api/metrics');
      if (!response.ok) throw new Error(`metrics unavailable (${String(response.status)})`);
      return (await response.json()) as MetricsPayload;
    },
  });

  const data = metrics.data;

  const stageData = useMemo(
    () => (data?.stages ?? []).map((row) => ({ stage: row.stage, hours: hours(row.totalMs) })),
    [data],
  );
  const columnData = useMemo(
    () => Object.entries(data?.cumulative ?? {}).map(([stage, count]) => ({ stage, count })),
    [data],
  );
  const gateData = useMemo(() => data?.gates ?? [], [data]);

  if (metrics.isPending) return <p className="muted">loading metrics…</p>;
  if (metrics.isError) {
    return (
      <p className="error" role="alert">
        {metrics.error.message}
      </p>
    );
  }
  if (data === undefined) return <p className="muted">no metrics</p>;

  const noHistory = data.stages.length === 0;

  return (
    <div className="metrics">
      {noHistory ? (
        // Distinguished from "flow efficiency is 0%". No history and terrible
        // flow are different problems, and the first is not a problem at all.
        <p className="muted">
          Nothing has moved yet, so there is no flow to measure. These charts fill in as cards move
          through stages.
        </p>
      ) : null}

      <section className="metrics__row">
        <article className="metrics__card">
          <h3>Time per stage</h3>
          <p className="muted">
            The value stream.{' '}
            {data.bottleneck === null ? null : (
              <>
                <strong>{data.bottleneck.stage}</strong> is the binding constraint — optimising
                anywhere else will not move throughput.
              </>
            )}
          </p>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={stageData}>
              <CartesianGrid stroke="var(--line)" vertical={false} />
              <XAxis dataKey="stage" stroke="var(--muted)" fontSize={11} />
              <YAxis stroke="var(--muted)" fontSize={11} unit="h" />
              <Tooltip
                contentStyle={{ background: 'var(--panel)', border: '1px solid var(--line)' }}
              />
              <Bar dataKey="hours" fill="var(--accent)" />
            </BarChart>
          </ResponsiveContainer>
        </article>

        <article className="metrics__card">
          <h3>Cards per stage, right now</h3>
          <p className="muted">
            A snapshot, not a cumulative flow diagram — nothing records a daily series yet, and a
            trend line drawn from one point would be an invention.
          </p>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={columnData}>
              <CartesianGrid stroke="var(--line)" vertical={false} />
              <XAxis dataKey="stage" stroke="var(--muted)" fontSize={11} />
              <YAxis stroke="var(--muted)" fontSize={11} allowDecimals={false} />
              <Tooltip
                contentStyle={{ background: 'var(--panel)', border: '1px solid var(--line)' }}
              />
              <Bar dataKey="count" fill="var(--ok)" />
            </BarChart>
          </ResponsiveContainer>
        </article>
      </section>

      <section className="metrics__row">
        <article className="metrics__card">
          <h3>Gate results</h3>
          {gateData.length === 0 ? (
            // Not an empty chart. No gates run is a fact worth stating, and an
            // empty axis reads as "all passing".
            <p className="muted">no gate has run on any card yet — this is not a pass</p>
          ) : (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={gateData}>
                <CartesianGrid stroke="var(--line)" vertical={false} />
                <XAxis dataKey="gate" stroke="var(--muted)" fontSize={11} />
                <YAxis stroke="var(--muted)" fontSize={11} allowDecimals={false} />
                <Tooltip
                  contentStyle={{ background: 'var(--panel)', border: '1px solid var(--line)' }}
                />
                <Legend />
                <Bar dataKey="count">
                  {gateData.map((row, index) => (
                    <Cell key={index} fill={RESULT_COLOR[row.result] ?? 'var(--muted)'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </article>

        <article className="metrics__card">
          <h3>Flow efficiency and rework</h3>
          <dl className="metrics__figures">
            <dt>flow efficiency</dt>
            <dd>
              {data.flowEfficiency.ratio === null
                ? 'not available'
                : `${(data.flowEfficiency.ratio * 100).toFixed(1)}%`}
            </dd>
            <dt>working / waiting</dt>
            <dd>
              {hours(data.flowEfficiency.activeMs)}h / {hours(data.flowEfficiency.waitMs)}h
            </dd>
            <dt>cards reworked</dt>
            <dd>{data.rework.cardsWithRework}</dd>
            <dt>total revisits</dt>
            <dd>{data.rework.totalRevisits}</dd>
            <dt>cards with a cycle time</dt>
            <dd>{data.cycleTimes.length}</dd>
          </dl>
          {data.rework.hotspots.length > 0 ? (
            <p className="muted">
              most returned to:{' '}
              {data.rework.hotspots
                .slice(0, 3)
                .map((hotspot) => `${hotspot.stage} ×${String(hotspot.revisits)}`)
                .join(', ')}
            </p>
          ) : null}
        </article>
      </section>
    </div>
  );
}
