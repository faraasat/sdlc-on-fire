/**
 * The browser-safe surface of core (P3-KAN-01).
 *
 * `index.ts` is a barrel over everything, and seven of those modules import
 * `node:path` or `node:crypto`. A bundler answers that by *stubbing* the
 * built-ins, which means the UI builds cleanly and then throws at runtime the
 * first time any code path reaches one — a failure that appears in a user's
 * browser and in no test here.
 *
 * This entry exists so that boundary is a build error instead. Adding an import
 * of a Node-dependent module to this file fails the UI build immediately, at
 * the moment somebody makes the mistake, rather than in production.
 *
 * Everything re-exported below is pure: data, predicates and projections.
 */

export * from './lifecycle.js';
export * from './board.js';
export * from './view-definition.js';
export * from './identity.js';
export * from './capability.js';
export * from './change-event.js';
export * from './test-tiers.js';
export * from './test-knowledge.js';
export * from './evidence.js';
export * from './context-provenance.js';
export * from './flow-metrics.js';
export * from './dora.js';
export * from './wip-limits.js';
export * from './contention.js';
export * from './presence.js';
export * from './board-move.js';
export * from './card-progress.js';
export * from './evidence-binding.js';
export * from './visual-diff.js';
export * from './agent-teammate.js';
export * from './activity.js';
export * from './notification.js';
export * from './llms-txt.js';
export * from './spec-authoring.js';
export * from './codebase-map.js';
export * from './visibility-matrix.js';
export * from './visibility-analysis.js';
export * from './web-bundle.js';
export * from './preview-env.js';
export * from './embedder-registry.js';
