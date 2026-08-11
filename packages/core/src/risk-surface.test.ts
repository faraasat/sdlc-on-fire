import { describe, expect, it } from 'vitest';
import { detectRiskSurfaces, RISK_SURFACES, surfacesTouched } from './risk-surface.js';

/**
 * P2-SEC-03 — high-risk surface detection.
 *
 * The tradeoff here is the opposite of the dangerous-command matcher's, and
 * the tests are written from that: a false positive costs one unnecessary
 * review, a false negative ships an auth change nobody looked at. So the
 * inclusive cases are the ones that must hold.
 */

describe('detectRiskSurfaces — by path', () => {
  const cases: readonly [string, string][] = [
    ['src/auth/session.ts', 'auth'],
    ['app/login/route.ts', 'auth'],
    ['src/oauth/callback.ts', 'auth'],
    ['server/billing/invoice.ts', 'payments'],
    ['src/checkout/index.ts', 'payments'],
    ['db/migrations/001_users.sql', 'migrations'],
    ['prisma/migrate/20250101_add.ts', 'migrations'],
    ['src/upload/handler.ts', 'uploads'],
    ['src/vault/client.ts', 'secrets'],
    ['src/rbac/policy.ts', 'permissions'],
    ['.github/workflows/deploy.yml', 'deployment'],
    ['Dockerfile', 'deployment'],
    ['infra/terraform/main.tf', 'infra'],
    ['k8s/deployment.yaml', 'infra'],
  ];

  for (const [path, surface] of cases) {
    it(`flags ${path} as ${surface}`, () => {
      const findings = detectRiskSurfaces([{ path }]);
      expect(findings.map((f) => f.surface)).toContain(surface);
    });
  }
});

describe('detectRiskSurfaces — by content', () => {
  it('catches an auth change in a file whose path says nothing', () => {
    // The more dangerous case: nothing about `utils/helpers.ts` suggests
    // anyone should look at it.
    const findings = detectRiskSurfaces([
      { path: 'src/utils/helpers.ts', addedContent: 'const ok = jwt.verify(token, secret);' },
    ]);
    expect(findings.map((f) => f.surface)).toContain('auth');
    expect(findings[0]?.evidence).toContain('credentials');
  });

  it('catches money moving from an innocuous path', () => {
    const findings = detectRiskSurfaces([
      { path: 'src/lib/orders.ts', addedContent: 'await stripe.charges.capturePayment(id);' },
    ]);
    expect(findings.map((f) => f.surface)).toContain('payments');
  });

  it('catches an outbound call', () => {
    const findings = detectRiskSurfaces([
      { path: 'src/lib/sync.ts', addedContent: 'const r = await fetch(url);' },
    ]);
    expect(findings.map((f) => f.surface)).toContain('external-api');
  });

  it('catches a schema change written inline', () => {
    const findings = detectRiskSurfaces([
      {
        path: 'src/db/setup.ts',
        addedContent: 'await db.query("ALTER TABLE users DROP COLUMN x")',
      },
    ]);
    expect(findings.map((f) => f.surface)).toContain('migrations');
  });

  it('reads only the added lines', () => {
    // A content rule over whole files would fire on every change to any file
    // that has ever contained a `fetch(` — which, in a mature codebase, is
    // most of them. A gate that fires on everything gets clicked through.
    const findings = detectRiskSurfaces([
      { path: 'src/lib/sync.ts', addedContent: '// tidy up the comment' },
    ]);
    expect(findings).toEqual([]);
  });

  it('finds nothing in a file with no added lines', () => {
    expect(detectRiskSurfaces([{ path: 'src/lib/sync.ts' }])).toEqual([]);
  });
});

describe('detectRiskSurfaces — ordinary changes are not obstructed', () => {
  const ordinary = [
    'README.md',
    'src/components/Button.tsx',
    'docs/architecture.md',
    'src/utils/format-date.ts',
    'packages/core/src/index.ts',
  ];

  for (const path of ordinary) {
    it(`leaves ${path} alone`, () => {
      expect(detectRiskSurfaces([{ path, addedContent: 'export const x = 1;' }])).toEqual([]);
    });
  }
});

describe('detectRiskSurfaces — shape of the result', () => {
  it('reports one finding per surface per file', () => {
    // A file matching three auth patterns is one auth change; three rows would
    // read as three.
    const findings = detectRiskSurfaces([
      {
        path: 'src/auth/session.ts',
        addedContent: 'jwt.verify(t); const h = bcrypt.hash(p); createSession();',
      },
    ]);
    expect(findings.filter((f) => f.surface === 'auth')).toHaveLength(1);
  });

  it('carries evidence a person can argue with', () => {
    const [finding] = detectRiskSurfaces([{ path: 'src/auth/session.ts' }]);
    // The remedy for a noisy rule is to argue with that rule, which requires
    // knowing which one fired.
    expect(finding?.evidence).not.toBe('');
    expect(finding?.path).toBe('src/auth/session.ts');
  });

  it('reports every distinct surface a change spans', () => {
    const findings = detectRiskSurfaces([
      { path: 'src/auth/session.ts' },
      { path: 'db/migrations/002.sql' },
      { path: 'README.md' },
    ]);
    expect(surfacesTouched(findings)).toEqual(['auth', 'migrations']);
  });

  it('orders surfaces canonically, not by encounter', () => {
    // A stable order means two runs over the same change produce the same
    // report, which is what makes the output diffable.
    const findings = detectRiskSurfaces([
      { path: 'infra/main.tf' },
      { path: 'src/auth/x.ts' },
      { path: 'src/upload/y.ts' },
    ]);
    const touched = surfacesTouched(findings);
    const canonical = RISK_SURFACES.filter((s) => touched.includes(s));
    expect(touched).toEqual(canonical);
  });

  it('reports nothing for an empty change', () => {
    expect(detectRiskSurfaces([])).toEqual([]);
    expect(surfacesTouched([])).toEqual([]);
  });
});
