/**
 * The deferred-loading trigger (ADR-0024, gating P2-AGT-02 and P2-AGT-03).
 *
 * ADR-0024 adopts Tool Search Tool and Programmatic Tool Calling "once the tool
 * registry actually grows large enough to need them". That sentence is a
 * judgement, and a judgement recorded in a tracker is one somebody re-makes
 * from scratch two years later with no way to tell whether the moment arrived.
 * This turns it into a number that fires on its own.
 *
 * **The threshold is the vendor's, not ours.** Anthropic's runtime marks MCP
 * tools with `defer_loading` once their descriptions exceed roughly **10,000
 * tokens** — that is the point at which the platform itself decides upfront
 * loading no longer pays, and it is therefore the honest point at which our own
 * deferred-loading work stops being speculative. Checked live 2026-08-22;
 * recorded as `~` because the figure comes from secondary write-ups of the
 * feature rather than from a spec page we could fetch, so it is a *lead we act
 * on*, not a constant we claim (ADR-0073 tier B/C).
 *
 * We trip at 60% of it. Crossing the vendor's own threshold is the point at
 * which the work is already overdue; the useful alarm goes off while there is
 * still time to do it deliberately.
 */

import { estimateTokens } from '@sdlc-on-fire/core';
import type { McpTool } from './mcp.js';

/**
 * Four characters per token, the same heuristic `@sdlc-on-fire/context` uses.
 *
 * Duplicated rather than imported, deliberately. This package depends on `yaml`
 * and `zod` and nothing else — it is the compile target for other people's
 * agent formats, and giving it a dependency on the context engine would invert
 * the layering for one line of arithmetic.
 *
 * **That constraint was right and the fix was wrong** (corrected P8-EVID-03).
 * The copy is gone: `estimateTokens` moved to `core`, which both packages
 * already depend on, so the layering holds *and* there is one implementation.
 * The guard test that pinned the two copies equal now pins this import against
 * the same source — a rule that needs a test to stop two copies drifting was
 * always a rule that wanted one copy.
 */

/** Where Anthropic's runtime begins deferring tool definitions (~, 2026-08-22). */
export const DEFER_LOADING_TOKENS = 10_000;

/** The fraction of it at which this repo wants to be told. */
export const TOOL_BUDGET_WARN_FRACTION = 0.6;

export interface ToolBudget {
  readonly tools: number;
  readonly tokens: number;
  readonly threshold: number;
  /** True once the registry is large enough that ADR-0024's condition is met. */
  readonly conditionMet: boolean;
  readonly because: string;
}

/**
 * What the registry currently costs a model, in the units the platform uses.
 *
 * Name, title, description and the serialised input schema — everything that
 * ships in a tool definition and therefore everything that occupies context
 * before any work happens. Counting only descriptions would understate it;
 * schemas are frequently the larger half.
 */
export function toolBudget(tools: readonly McpTool[]): ToolBudget {
  const tokens = tools.reduce(
    (total, tool) =>
      total +
      estimateTokens(tool.name) +
      estimateTokens(tool.title) +
      estimateTokens(tool.description) +
      estimateTokens(JSON.stringify(tool.inputSchema)),
    0,
  );

  const threshold = Math.floor(DEFER_LOADING_TOKENS * TOOL_BUDGET_WARN_FRACTION);
  const conditionMet = tokens >= threshold;

  return {
    tools: tools.length,
    tokens,
    threshold,
    conditionMet,
    because: conditionMet
      ? `${String(tools.length)} tool(s) cost ~${String(tokens)} tokens, at or past the ${String(threshold)}-token trigger — ADR-0024's condition for P2-AGT-02 (Tool Search) and P2-AGT-03 (Programmatic Tool Calling) is met`
      : `${String(tools.length)} tool(s) cost ~${String(tokens)} tokens of a ${String(threshold)}-token trigger — deferred loading is not yet worth its own machinery`,
  };
}
