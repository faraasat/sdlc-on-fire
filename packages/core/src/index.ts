/**
 * `@sdlc-on-fire/core` — the object model.
 *
 * Zod is the single type source (contracts/README.md): every exported TS type
 * here is a `z.infer` of a schema defined once in this package, never a
 * hand-written interface duplicated downstream. `packages/storage`, `db`,
 * `daemon`, and `evidence` all import their shapes from here.
 */

export * from './ids.js';
export * from './lifecycle.js';
export * from './work-item.js';
export * from './constitution.js';
export * from './evidence.js';
export * from './focus.js';
export * from './run.js';
export * from './context.js';
export * from './handoff.js';
export * from './echo-back.js';
export * from './comment-effect.js';
export * from './role-registry.js';
export * from './review-lens.js';
export * from './embedding.js';
export * from './memory.js';
export * from './memory-entry.js';
export * from './improvement.js';
export * from './mcp-catalogue.js';
export * from './mcp-client.js';
export * from './capability.js';
export * from './source-tier.js';
export * from './held-out.js';
export * from './test-knowledge.js';
export * from './pilot.js';
export * from './posix-path.js';
export * from './test-environment.js';
export * from './tech-research.js';
export * from './tech-stack.js';
export * from './workspace.js';
export * from './storage-port.js';
export * from './capabilities.js';
export * from './idempotency.js';
export * from './credential-mask.js';
export * from './resource-limits.js';
export * from './sandbox.js';
export * from './skill.js';
export * from './subagent-caps.js';
export * from './tier-policy.js';
export * from './hash.js';
export * from './task-spec.js';
export * from './preset.js';
export * from './docs.js';
export * from './package-risk.js';
export * from './secret-scan.js';
export * from './secret-allowlist.js';
export * from './risk-surface.js';
export * from './ui-surface.js';
export * from './risk-record.js';
export * from './run-metrics.js';
export * from './situations.js';
export * from './research-subtype.js';
export * from './license-policy.js';
export * from './compromise-watch.js';
export * from './secret-paths.js';
export * from './injection-scan.js';
export * from './dangerous-command.js';
export * from './command-normalize.js';
export * from './pii-redact.js';
export * from './threat-model.js';
export * from './agent-scope.js';
export * from './revert-guard.js';
export * from './upgrade-triage.js';
export * from './regression-scope.js';
export * from './confidence.js';
export * from './migration-plan.js';
export * from './blast-radius.js';
export * from './insertion.js';
export * from './gate-reopen.js';
export * from './merge-conflict.js';
export * from './test-tiers.js';
export * from './plugin-manifest.js';
export * from './change-event.js';
export * from './identity.js';
export * from './board.js';
export * from './view-definition.js';
export * from './context-provenance.js';

/**
 * Package identity, surfaced by `sdlc doctor` so a running install can report
 * exactly which packages it is composed of.
 */
export interface PackageInfo {
  readonly name: string;
  /** Workspace packages this one depends on, by npm name. */
  readonly dependsOn: readonly string[];
}

/**
 * Identity of the `@sdlc-on-fire/core` package. Core sits at the root of the
 * dependency graph and imports no other workspace package — the ports-never-
 * import-adapters discipline (architecture §4a) starts here.
 */
export const corePackage: PackageInfo = {
  name: '@sdlc-on-fire/core',
  dependsOn: [],
};
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
export * from './skill-signing.js';
export * from './skill-registry.js';
export * from './tracker-sync.js';
export * from './github-issues.js';
export * from './sync-engine.js';
export * from './github-sync-port.js';
export * from './run-record.js';
