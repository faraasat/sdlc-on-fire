import { describe, expect, it } from 'vitest';
import {
  AGENT_SCOPES,
  deriveScopes,
  formatGrant,
  passthroughIssuer,
  permits,
} from './agent-scope.js';

/**
 * P2-SEC-05 — daemon-scoped credential derivation.
 *
 * The property under test throughout: an agent cannot be talked into a scope it
 * was never granted. The instruction layer is advisory; the scope is not.
 */

describe('deriveScopes', () => {
  it('gives a read-only stage read-only scopes', () => {
    const grant = deriveScopes({ stage: 'spec' });
    expect(grant.granted).toEqual(['repo:read']);
    expect(permits(grant, 'repo:write')).toBe(false);
  });

  it('gives implement what it needs to do the work, and no more', () => {
    const grant = deriveScopes({ stage: 'implement' });
    expect(grant.granted).toEqual(['repo:read', 'repo:write', 'branch:push']);
    // The one that matters: an injected "just push to main" cannot succeed,
    // because the credential in hand cannot do it.
    expect(permits(grant, 'main:push')).toBe(false);
  });

  it('grants no stage the dangerous scopes at all', () => {
    for (const stage of ['discovery', 'spec', 'implement', 'review', 'retrospective']) {
      const grant = deriveScopes({ stage });
      // Absent from the vocabulary rather than withheld pending a good reason,
      // so there is no argument an injected instruction can win.
      expect(permits(grant, 'main:push')).toBe(false);
      expect(permits(grant, 'package:publish')).toBe(false);
      expect(permits(grant, 'secrets:read')).toBe(false);
    }
  });

  it('lets a request narrow the ceiling', () => {
    const grant = deriveScopes({ stage: 'implement', requested: ['repo:read'] });
    expect(grant.granted).toEqual(['repo:read']);
  });

  it('refuses a request above the ceiling rather than clamping it quietly', () => {
    const grant = deriveScopes({ stage: 'review', requested: ['repo:read', 'main:push'] });
    expect(grant.granted).toEqual(['repo:read']);
    // A `review` agent asking for `main:push` is either a misconfiguration or
    // an attempt. Both warrant a line somebody can read.
    expect(grant.refused).toHaveLength(1);
    expect(grant.refused[0]?.scope).toBe('main:push');
    expect(grant.refused[0]?.reason).toContain('review');
  });

  it('grants nothing for a stage it does not know', () => {
    // Fail closed: an unrecognised stage is not a licence to guess.
    expect(deriveScopes({ stage: 'not-a-stage' }).granted).toEqual([]);
  });

  it('adds network egress only when the caller says the work needs it', () => {
    expect(permits(deriveScopes({ stage: 'implement' }), 'network:egress')).toBe(false);
    expect(
      permits(deriveScopes({ stage: 'implement', needsNetwork: true }), 'network:egress'),
    ).toBe(true);
  });

  it('is canonically ordered and deduplicated', () => {
    const grant = deriveScopes({
      stage: 'implement',
      requested: ['branch:push', 'repo:read', 'repo:read'],
    });
    // Two derivations of the same request must produce byte-identical grants,
    // or a diff of them means nothing.
    expect(grant.granted).toEqual(['repo:read', 'branch:push']);
    expect(grant.granted).toEqual(AGENT_SCOPES.filter((s) => grant.granted.includes(s)));
  });

  it('grants nothing when an empty request is made explicitly', () => {
    expect(deriveScopes({ stage: 'implement', requested: [] }).granted).toEqual([]);
  });
});

describe('passthroughIssuer', () => {
  it('reports that it did not narrow anything', async () => {
    const credential = await passthroughIssuer(() => 'ghp_ambient').issue(
      deriveScopes({ stage: 'implement' }),
    );
    // Reporting the derived scopes as though enforced would turn "we did not
    // restrict this" into "this is restricted" — the exact substitution this
    // product refuses everywhere else.
    expect(credential.scoped).toBe(false);
    expect(credential.token).toBe('ghp_ambient');
  });

  it('returns an empty token rather than throwing when none is present', async () => {
    const credential = await passthroughIssuer(() => undefined).issue(
      deriveScopes({ stage: 'spec' }),
    );
    expect(credential.token).toBe('');
  });
});

describe('formatGrant', () => {
  it('says the scopes are aspirational when nothing was actually scoped', async () => {
    const grant = deriveScopes({ stage: 'implement' });
    const credential = await passthroughIssuer(() => 'x').issue(grant);
    const text = formatGrant(grant, credential);
    expect(text).toContain('what this agent *should* hold, not what it does');
  });

  it('does not cry unscoped when the issuer really scoped it', () => {
    const grant = deriveScopes({ stage: 'implement' });
    const text = formatGrant(grant, {
      token: 't',
      scopes: grant.granted,
      expiresAt: '2026-01-01T00:00:00.000Z',
      issuer: 'github-app',
      scoped: true,
    });
    expect(text).not.toContain('should* hold');
  });

  it('names every refusal', () => {
    const grant = deriveScopes({ stage: 'spec', requested: ['repo:write', 'main:push'] });
    const text = formatGrant(grant);
    expect(text).toContain('refused repo:write');
    expect(text).toContain('refused main:push');
  });

  it('says plainly when a stage gets nothing', () => {
    expect(formatGrant(deriveScopes({ stage: 'unknown' }))).toContain('(no scopes)');
  });
});
