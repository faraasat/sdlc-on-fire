import { describe, expect, it } from 'vitest';
import { estimateTokens as contextEstimate } from '@sdlc-on-fire/context';
import { DEFER_LOADING_TOKENS, TOOL_BUDGET_WARN_FRACTION, toolBudget } from './tool-budget.js';
import type { McpTool } from './mcp.js';

/**
 * ADR-0024's condition, as a tripwire (gating P2-AGT-02 / P2-AGT-03).
 *
 * The founder's call on 2026-08-22 was to keep both deferred. That is only safe
 * if the trigger is checkable — a judgement recorded in a tracker is one
 * somebody re-makes from scratch later with no way to tell whether the moment
 * arrived. These tests are the mechanism that tells them.
 */

const tool = (over: Partial<McpTool> = {}): McpTool => ({
  name: 'sdlc__spec',
  title: 'Write a spec',
  description: 'Authors a specification for a domain.',
  inputSchema: { type: 'object', properties: { domain: { type: 'string' } } },
  _meta: {},
  ...over,
});

describe('toolBudget', () => {
  it('counts a small registry as not yet worth deferring', () => {
    const budget = toolBudget([tool(), tool({ name: 'sdlc__gate' })]);
    expect(budget.conditionMet).toBe(false);
    expect(budget.because).toContain('not yet worth its own machinery');
  });

  it('trips once the registry reaches the trigger', () => {
    // The alarm that unblocks P2-AGT-02 and P2-AGT-03 without anyone having to
    // remember to re-read an ADR.
    const fat = tool({ description: 'x'.repeat(40_000) });
    const budget = toolBudget([fat]);
    expect(budget.conditionMet).toBe(true);
    expect(budget.because).toContain('P2-AGT-02');
    expect(budget.because).toContain('P2-AGT-03');
  });

  it('counts the input schema, not only the description', () => {
    // Schemas are frequently the larger half of a tool definition; counting
    // descriptions alone understates what the registry actually costs.
    const lean = toolBudget([tool({ inputSchema: {} })]).tokens;
    const fat = toolBudget([
      tool({
        inputSchema: {
          type: 'object',
          properties: { a: { type: 'string', description: 'x'.repeat(400) } },
        },
      }),
    ]).tokens;
    expect(fat).toBeGreaterThan(lean);
  });

  it('trips below the vendor threshold, while there is still time to act', () => {
    // Crossing Anthropic's own defer-loading point means the work is already
    // overdue. The useful alarm goes off before that.
    expect(TOOL_BUDGET_WARN_FRACTION).toBeLessThan(1);
    expect(toolBudget([]).threshold).toBeLessThan(DEFER_LOADING_TOKENS);
  });

  it('reports zero for an empty registry rather than dividing by nothing', () => {
    expect(toolBudget([])).toMatchObject({ tools: 0, tokens: 0, conditionMet: false });
  });

  it('uses the same token heuristic as the context engine', () => {
    // The estimator is duplicated here so this package keeps its two-dependency
    // surface. This is the guard that stops the copy drifting: if the context
    // engine ever changes how it counts, this goes red rather than the two
    // quietly disagreeing about what a tool costs.
    const sample = 'a'.repeat(4001);
    const viaBudget = toolBudget([
      { name: '', title: '', description: sample, inputSchema: {}, _meta: {} },
    ]).tokens;
    // `inputSchema: {}` serialises to `{}` — two characters, one token.
    expect(viaBudget).toBe(contextEstimate(sample) + contextEstimate('{}'));
  });
});
