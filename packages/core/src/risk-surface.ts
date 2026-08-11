/**
 * High-risk surface detection (P2-SEC-03, `.research/14 §(e)`).
 *
 * `base-idea.md` locks the list: auth, payments, migrations, uploads, external
 * APIs, secrets, permissions, deployment, infra. A change touching any of them
 * gets a mandatory security review and an auto-created risk card.
 *
 * **Why paths and content, not a model.** The question "is this an auth
 * change?" is exactly the kind a language model answers plausibly and
 * inconsistently. A gate whose trigger condition varies between runs is not a
 * gate — the same diff must produce the same requirement today and in six
 * months (ADR-0040). So this is a table: paths that are auth code, and content
 * signatures for the cases where the path does not say so.
 *
 * **Both signals, because each misses what the other catches.** A file at
 * `src/auth/session.ts` is auth regardless of its contents. A file at
 * `src/utils/helpers.ts` that adds `jwt.verify(` is auth regardless of its
 * path — and it is the more dangerous case, because nothing about where it
 * lives suggests anyone should look.
 *
 * **Over-triggering is the tolerable failure here**, which is the opposite of
 * the dangerous-command matcher's tradeoff and worth stating plainly. A false
 * positive costs one review of a change that did not need one. A false negative
 * ships an auth change nobody looked at. So the patterns lean inclusive, and
 * the remedy for noise is to argue with a specific rule in this file rather
 * than to loosen the whole thing.
 */

export const RISK_SURFACES = [
  'auth',
  'payments',
  'migrations',
  'uploads',
  'external-api',
  'secrets',
  'permissions',
  'deployment',
  'infra',
] as const;

export type RiskSurface = (typeof RISK_SURFACES)[number];

export interface SurfaceFinding {
  readonly surface: RiskSurface;
  readonly path: string;
  /** What matched — a path rule or a content signature — so it can be argued with. */
  readonly evidence: string;
}

interface SurfaceRule {
  readonly surface: RiskSurface;
  readonly path?: RegExp;
  readonly content?: RegExp;
  readonly label: string;
}

const RULES: readonly SurfaceRule[] = [
  {
    surface: 'auth',
    path: /(?:^|\/)(?:auth|authn|authz|login|logout|session|oauth|saml|sso|passport|identity)[/.]/i,
    label: 'path is authentication code',
  },
  {
    surface: 'auth',
    content:
      /\b(?:jwt\.(?:sign|verify)|verifyToken|signToken|bcrypt|argon2|scrypt|createSession|passwordHash|comparePassword|refreshToken)\b/,
    label: 'handles credentials, tokens, or sessions',
  },
  {
    surface: 'payments',
    path: /(?:^|\/)(?:payment|billing|checkout|invoice|subscription|stripe|paypal|braintree)[/.]/i,
    label: 'path is payment code',
  },
  {
    surface: 'payments',
    content: /\b(?:chargeCard|createCharge|PaymentIntent|capturePayment|refund(?:Payment)?)\b/,
    label: 'moves money',
  },
  {
    surface: 'migrations',
    // A migration is irreversible in production in a way ordinary code is not.
    path: /(?:^|\/)(?:migrations?|migrate)\/|\.(?:sql)$|(?:^|\/)\d{14}_.*\.(?:ts|js|sql)$/i,
    label: 'path is a schema migration',
  },
  {
    surface: 'migrations',
    content: /\b(?:ALTER\s+TABLE|DROP\s+COLUMN|CREATE\s+INDEX\s+CONCURRENTLY|ADD\s+CONSTRAINT)\b/i,
    label: 'alters a database schema',
  },
  {
    surface: 'uploads',
    path: /(?:^|\/)(?:upload|attachment|multipart|storage-bucket)[/.]/i,
    label: 'path handles file uploads',
  },
  {
    surface: 'uploads',
    content: /\b(?:multer|busboy|createReadStream\(req|formidable|getSignedUrl|putObject)\b/,
    label: 'accepts uploaded files',
  },
  {
    surface: 'external-api',
    content: /\b(?:fetch\(|axios\.(?:get|post|put|delete)|https?\.request|got\(|undici)\b/,
    label: 'calls an external service',
  },
  {
    surface: 'secrets',
    path: /(?:^|\/)(?:secrets?|credentials?|vault|keystore)[/.]/i,
    label: 'path handles secrets',
  },
  {
    surface: 'secrets',
    content: /\bprocess\.env\.[A-Z_]*(?:SECRET|TOKEN|KEY|PASSWORD|CREDENTIAL)/,
    label: 'reads a secret from the environment',
  },
  {
    surface: 'permissions',
    path: /(?:^|\/)(?:rbac|acl|permissions?|roles?|policy|policies|guard)[/.]/i,
    label: 'path is access control',
  },
  {
    surface: 'permissions',
    content: /\b(?:hasPermission|checkAccess|requireRole|canAccess|authorize|isAdmin)\b/,
    label: 'decides who may do what',
  },
  {
    surface: 'deployment',
    path: /(?:^|\/)(?:\.github\/workflows|\.gitlab-ci|Dockerfile|docker-compose|Jenkinsfile|\.circleci)/i,
    label: 'path is deployment or CI configuration',
  },
  {
    surface: 'infra',
    path: /\.(?:tf|tfvars)$|(?:^|\/)(?:terraform|pulumi|cloudformation|helm|k8s|kubernetes)[/.]/i,
    label: 'path is infrastructure as code',
  },
];

export interface ChangedFile {
  readonly path: string;
  /** The added lines. Content rules read only what the change introduced. */
  readonly addedContent?: string | undefined;
}

/**
 * Every high-risk surface a change touches.
 *
 * Content rules are applied to **added lines only**. Running them over the
 * whole file would flag every change to a file that has ever contained a
 * `fetch(` — which, in a mature codebase, is most of them, and a gate that
 * fires on everything is a gate people learn to click through.
 */
export function detectRiskSurfaces(files: readonly ChangedFile[]): readonly SurfaceFinding[] {
  const findings: SurfaceFinding[] = [];
  const seen = new Set<string>();

  for (const file of files) {
    for (const rule of RULES) {
      const matched =
        (rule.path?.test(file.path) ?? false) ||
        (rule.content !== undefined &&
          file.addedContent !== undefined &&
          rule.content.test(file.addedContent));
      if (!matched) continue;

      // One finding per (surface, file): a file matching three auth patterns is
      // one auth change, and three identical rows would read as three.
      const key = `${rule.surface}:${file.path}`;
      if (seen.has(key)) continue;
      seen.add(key);

      findings.push({ surface: rule.surface, path: file.path, evidence: rule.label });
    }
  }

  return findings;
}

/** The distinct surfaces touched, in the locked order. */
export function surfacesTouched(findings: readonly SurfaceFinding[]): readonly RiskSurface[] {
  const present = new Set(findings.map((f) => f.surface));
  return RISK_SURFACES.filter((surface) => present.has(surface));
}
