/**
 * OpenTelemetry GenAI-conventions span adapter (P1-MET-01, FEAT-MET-016).
 *
 * A **thin** adapter, deliberately. It emits spans shaped to the OTel GenAI
 * semantic conventions from data the `runs` table already holds; it does not
 * become a second source of truth for what happened. Two systems disagreeing
 * about whether a run failed is worse than having no traces at all, so the DB
 * stays authoritative and this projects from it.
 *
 * Telemetry export is an advanced capability, **off by default** (ADR-0067,
 * cost class d — it sends data off the machine). Nothing here transmits
 * anything; it produces span objects a configured exporter may consume. That
 * separation is what lets the default stay local without this code needing to
 * know whether an exporter exists.
 */

/** Span names fixed by the GenAI conventions. Ours must match, or dashboards break. */
export const GENAI_SPANS = {
  invokeAgent: 'invoke_agent',
  executeTool: 'execute_tool',
} as const;

/** The metric name the conventions reserve for token usage. */
export const TOKEN_USAGE_METRIC = 'gen_ai.client.token.usage';

export interface GenAiSpan {
  readonly name: string;
  readonly startTimeUnixNano: number;
  readonly endTimeUnixNano: number | null;
  /** OTel status: unset until the run finishes, then ok or error. */
  readonly status: 'unset' | 'ok' | 'error';
  readonly attributes: Readonly<Record<string, string | number | boolean>>;
}

interface MetricsStore {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

interface RunRow {
  id: string;
  work_item_id: string;
  skill_id: string | null;
  agent_target: string | null;
  model: string | null;
  status: string | null;
  started_at: Date | string | null;
  finished_at: Date | string | null;
}

const nanos = (value: Date | string | null): number | null =>
  value === null ? null : (value instanceof Date ? value : new Date(value)).getTime() * 1_000_000;

/**
 * Maps a run's status onto an OTel span status.
 *
 * `pending`/`running` stay `unset` rather than becoming `ok`. A span reporting
 * success before the work finished is the specific way trace data starts lying,
 * and it lies in the optimistic direction, which is the worse one.
 */
function spanStatus(status: string | null): GenAiSpan['status'] {
  if (status === 'pass') return 'ok';
  if (status === 'fail' || status === 'error') return 'error';
  return 'unset';
}

/**
 * Projects runs into GenAI spans.
 *
 * Attributes use the conventions' names (`gen_ai.operation.name`,
 * `gen_ai.request.model`) so an off-the-shelf dashboard works with no mapping
 * layer. Our own identifiers go under a namespaced prefix rather than being
 * squeezed into a convention field that means something else — a work item id
 * is not a conversation id, and pretending otherwise corrupts any tool that
 * takes the convention seriously.
 */
export async function runSpans(store: MetricsStore, limit = 100): Promise<readonly GenAiSpan[]> {
  const rows = await store.query<RunRow>(
    `SELECT id, work_item_id, skill_id, agent_target, model, status, started_at, finished_at
       FROM runs ORDER BY started_at DESC NULLS LAST LIMIT $1;`,
    [limit],
  );

  return rows.map((row) => ({
    name: GENAI_SPANS.invokeAgent,
    startTimeUnixNano: nanos(row.started_at) ?? 0,
    endTimeUnixNano: nanos(row.finished_at),
    status: spanStatus(row.status),
    attributes: {
      'gen_ai.operation.name': GENAI_SPANS.invokeAgent,
      ...(row.model === null ? {} : { 'gen_ai.request.model': row.model }),
      ...(row.agent_target === null ? {} : { 'gen_ai.system': row.agent_target }),
      // Namespaced: these are ours, and do not belong in convention fields.
      'sdlcof.run.id': row.id,
      'sdlcof.work_item.id': row.work_item_id,
      ...(row.skill_id === null ? {} : { 'sdlcof.skill.id': row.skill_id }),
    },
  }));
}

export interface TokenUsageMeasurement {
  readonly name: typeof TOKEN_USAGE_METRIC;
  readonly value: number;
  readonly attributes: Readonly<Record<string, string>>;
}

/**
 * Projects recorded token usage into the conventions' metric shape.
 *
 * `gen_ai.token.type` is reported as `total` because that is what we store.
 * Splitting input from output would price correctly, but inventing the split
 * produces a number that looks like cost and is not.
 */
export async function tokenUsage(store: MetricsStore): Promise<readonly TokenUsageMeasurement[]> {
  const rows = await store.query<{ scope_id: string; used_tokens: string | number }>(
    `SELECT scope_id, used_tokens FROM token_budgets WHERE scope = 'agent';`,
  );

  return rows.map((row) => ({
    name: TOKEN_USAGE_METRIC,
    value: Number(row.used_tokens),
    attributes: {
      'gen_ai.operation.name': GENAI_SPANS.invokeAgent,
      'gen_ai.token.type': 'total',
      'sdlcof.agent.id': row.scope_id,
    },
  }));
}
