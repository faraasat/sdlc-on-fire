/**
 * Daemon-scoped credential derivation (P2-SEC-05, FEAT-SEC-008, ADR-0027).
 *
 * OWASP's 2026 framing is the whole idea: **"Least Agency — autonomy is a
 * feature that should be earned, not a default setting."** The daemon's own
 * token is narrower than the developer's shell session even when both run as
 * the same OS user on the same machine, because *same machine is not same
 * privilege*.
 *
 * What that means concretely: an agent doing a `spec` stage gets a credential
 * that can read the repository and nothing else. If a prompt injection
 * convinces it to push to `main`, the credential it holds cannot, and no amount
 * of persuasion changes that. The instruction layer is advisory; the scope is
 * not.
 *
 * **What ships here, stated plainly, is derivation — not issuance.** Minting a
 * genuinely narrower token needs a provider that supports it: a GitHub App
 * installation token, an STS `AssumeRole` with a session policy, a Vault role.
 * Those are adapters and they are not built. So this computes the minimal scope
 * set for a piece of work and exposes the port an adapter implements, and the
 * default adapter is honest about handing back what it was given.
 *
 * That honesty is the same shape as `credential-mask.ts`, which ships the
 * masking half of a scheme whose egress proxy does not exist. Half a control
 * that says which half it is beats a whole one that is not true.
 */

/**
 * The permissions an agent can hold.
 *
 * Deliberately coarse. A vocabulary fine enough to express everything is one
 * nobody uses correctly, and the cases that matter here are blunt: can this
 * agent write to the repository, can it reach the network, can it publish.
 */
import {
  DEFAULT_HELD_OUT_ROOT,
  isHeldOutPath,
  scopeToVisible,
  type SuiteScope,
} from './held-out-suite.js';

export const AGENT_SCOPES = [
  'repo:read',
  'repo:write',
  'branch:push',
  'main:push',
  'issue:write',
  'pr:create',
  'package:publish',
  'network:egress',
  'secrets:read',
] as const;

export type AgentScope = (typeof AGENT_SCOPES)[number];

/**
 * The scopes each lifecycle stage may hold.
 *
 * Read as a ceiling, not a grant: a stage never receives more than this, and
 * usually receives less once the work item narrows it further.
 *
 * `main:push`, `package:publish` and `secrets:read` appear in no stage at all.
 * That is the point — they are not withheld pending a good reason, they are
 * absent from the vocabulary any agent can draw on, so there is no argument an
 * injected instruction can win.
 */
const STAGE_CEILING: Readonly<Record<string, readonly AgentScope[]>> = {
  discovery: ['repo:read'],
  spec: ['repo:read'],
  decompose: ['repo:read'],
  'plan-story': ['repo:read'],
  implement: ['repo:read', 'repo:write', 'branch:push'],
  review: ['repo:read'],
  retrospective: ['repo:read'],
};

export interface ScopeRequest {
  readonly stage: string;
  /** What the work item declares it needs. Narrows; never widens. */
  readonly requested?: readonly AgentScope[] | undefined;
  /** Set when the daemon is running a verify step that fetches dependencies. */
  readonly needsNetwork?: boolean | undefined;
  /** Where this workspace keeps its held-out suite. Defaults to the conventional root. */
  readonly heldOutRoot?: string | undefined;
}

export interface ScopeGrant {
  readonly stage: string;
  readonly granted: readonly AgentScope[];
  /** Scopes asked for and refused, with why — refusals are never silent. */
  readonly refused: readonly { scope: AgentScope; reason: string }[];
  /**
   * The held-out root this grant is blind to (P7-HELDOUT-01).
   *
   * Carried on the grant rather than consulted from a constant at each call
   * site, so `permitsPath` cannot be asked the question without the answer
   * being in scope — and so a grant printed into a log says what it could not
   * see.
   */
  readonly heldOutRoot: string;
}

/**
 * The scopes an agent invocation actually gets.
 *
 * The request can only ever narrow the ceiling. A stage asking for more than
 * its ceiling is refused rather than clamped quietly, because a request for
 * `main:push` from a `review` agent is a fact somebody should see — it is
 * either a misconfiguration or an attempt, and both warrant a line in a log.
 */
export function deriveScopes(request: ScopeRequest): ScopeGrant {
  const ceiling = STAGE_CEILING[request.stage] ?? [];
  const refused: { scope: AgentScope; reason: string }[] = [];

  let granted: AgentScope[];
  if (request.requested === undefined) {
    granted = [...ceiling];
  } else {
    granted = [];
    for (const scope of request.requested) {
      if (ceiling.includes(scope)) granted.push(scope);
      else {
        refused.push({
          scope,
          reason: `"${request.stage}" agents never hold ${scope}`,
        });
      }
    }
  }

  if (request.needsNetwork === true && !granted.includes('network:egress')) {
    granted.push('network:egress');
  }

  // Deduplicated and canonically ordered, so two derivations of the same
  // request produce byte-identical grants and a diff of them means something.
  const unique = new Set(granted);
  return {
    stage: request.stage,
    granted: AGENT_SCOPES.filter((scope) => unique.has(scope)),
    refused,
    heldOutRoot: request.heldOutRoot ?? DEFAULT_HELD_OUT_ROOT,
  };
}

/**
 * Whether a grant permits touching a path (P7-HELDOUT-01).
 *
 * A separate question from {@link permits}, and asked separately on purpose:
 * `repo:read` says an agent may read the repository, and the held-out suite is
 * the one part of the repository no grant reaches, at any stage, with any
 * scope. There is no scope that turns it on — the same reasoning as `main:push`
 * being absent from the vocabulary rather than withheld: absence leaves no
 * argument an injected instruction can win.
 */
export function permitsPath(grant: ScopeGrant, candidate: string): boolean {
  return !isHeldOutPath(candidate, grant.heldOutRoot);
}

/**
 * Every path in `paths` this grant may touch, and everything it withheld.
 *
 * The plural form exists so a caller filters *once*, with the withheld set in
 * hand — a per-path `permitsPath` in a loop discards the count, and the count is
 * what makes a leak visible rather than merely absent.
 */
export function scopePaths(grant: ScopeGrant, paths: readonly string[]): SuiteScope {
  return scopeToVisible(paths, grant.heldOutRoot);
}

/**
 * Whether a grant permits an operation.
 *
 * A named function rather than an `includes` at each call site, so there is one
 * place where "may it" is answered and one place to audit.
 */
export function permits(grant: ScopeGrant, scope: AgentScope): boolean {
  return grant.granted.includes(scope);
}

export interface IssuedCredential {
  /** The value to hand the child process. */
  readonly token: string;
  readonly scopes: readonly AgentScope[];
  /** ISO 8601, or null when the issuer cannot express expiry. */
  readonly expiresAt: string | null;
  /** How this was obtained, so a log records what was actually done. */
  readonly issuer: string;
  /**
   * False when the token is not genuinely narrower than the caller's own.
   *
   * The field exists so the gap cannot hide. A pass-through issuer returns
   * `false` here, and anything reporting on credentials has to say so rather
   * than print a scope list that implies a restriction nobody applied.
   */
  readonly scoped: boolean;
}

export interface CredentialIssuer {
  readonly id: string;
  issue(grant: ScopeGrant): Promise<IssuedCredential>;
}

/**
 * The issuer used when no provider adapter is configured.
 *
 * It hands back the ambient token and **says it did not narrow anything**. The
 * alternative — reporting the derived scopes as though they had been enforced —
 * would be the exact substitution this product refuses everywhere else: turning
 * "we did not restrict this" into "this is restricted".
 */
export function passthroughIssuer(readEnv: () => string | undefined): CredentialIssuer {
  return {
    id: 'passthrough',
    issue: (grant) =>
      Promise.resolve({
        token: readEnv() ?? '',
        scopes: grant.granted,
        expiresAt: null,
        issuer: 'passthrough',
        scoped: false,
      }),
  };
}

export function formatGrant(grant: ScopeGrant, credential?: IssuedCredential): string {
  const lines = [
    `${grant.stage}: ${grant.granted.length === 0 ? '(no scopes)' : grant.granted.join(', ')}`,
  ];
  for (const refusal of grant.refused) {
    lines.push(`  refused ${refusal.scope} — ${refusal.reason}`);
  }
  if (credential !== undefined && !credential.scoped) {
    lines.push(
      '',
      `The ${credential.issuer} issuer cannot mint a narrower token, so the scopes above`,
      'describe what this agent *should* hold, not what it does. Configure a provider',
      'that issues scoped credentials before treating this as a restriction.',
    );
  }
  return lines.join('\n');
}
