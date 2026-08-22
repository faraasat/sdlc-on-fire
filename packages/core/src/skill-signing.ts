/**
 * Signed skills and plugins (P5-ECO-04).
 *
 * The pipeline a third-party skill goes through before anybody's agent runs it:
 * **review → automated scan → sign → catalog.** Each stage produces something
 * checkable, and the signature covers the *whole record* rather than the
 * artifact alone — so "this was reviewed" and "this was scanned" are as
 * tamper-evident as "this is the file".
 *
 * **A signature says who, not whether it is safe.** This is the sentence the
 * whole module is arranged around. Signing proves a specific key vouched for
 * specific bytes; it says nothing about whether the code is good, and a
 * registry that renders a checkmark next to "signed" has converted a provenance
 * claim into a safety claim it cannot support. `verifySignature` therefore
 * returns *who signed* and never a bare boolean that could be read as approval
 * — the trust decision belongs to whoever holds the key list, which is
 * P5-ECO-05.
 *
 * **The scan is a gate, not a report.** An artifact that fails the scan cannot
 * be signed, because a signature over a known-bad artifact is worse than no
 * signature: it carries authority in the direction of the defect.
 *
 * Ed25519 via `node:crypto` — no dependency, deterministic, and verifiable
 * offline, which means every property here is testable without a key server.
 */

import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';

export const SIGNING_ALGORITHM = 'ed25519';

/** What is being vouched for. */
export interface SkillArtifact {
  readonly name: string;
  readonly version: string;
  /** The file bytes, as text. */
  readonly content: string;
}

export const SCAN_SEVERITIES = ['block', 'warn'] as const;
export type ScanSeverity = (typeof SCAN_SEVERITIES)[number];

export interface ScanFinding {
  readonly rule: string;
  readonly severity: ScanSeverity;
  readonly detail: string;
}

/**
 * The automated scan.
 *
 * Named `scanSkillArtifact` rather than `scanArtifact`, which
 * `test-environment.ts` already uses for a different job: that one looks for
 * leaked secrets in *evidence* we produced, this one looks for hostile patterns
 * in *code somebody else wrote*. Same verb, opposite trust assumptions, and one
 * name for both would be an invitation to reach for whichever came to hand.
 *
 * Deliberately a small set of patterns with no model in the path (ADR-0040).
 * It is not a security product and does not pretend to be one — it catches the
 * things that are *definitionally* wrong in a declarative skill file, where a
 * false positive is cheap and a miss is not.
 */
export function scanSkillArtifact(artifact: SkillArtifact): readonly ScanFinding[] {
  const findings: ScanFinding[] = [];
  const content = artifact.content;

  const rules: readonly {
    rule: string;
    pattern: RegExp;
    severity: ScanSeverity;
    detail: string;
  }[] = [
    {
      rule: 'remote-execution',
      pattern: /curl[^\n|]*\|\s*(?:ba)?sh|wget[^\n|]*\|\s*(?:ba)?sh/i,
      severity: 'block',
      detail: 'pipes a downloaded script straight into a shell',
    },
    {
      rule: 'credential-exfiltration',
      pattern:
        /(?:AWS_SECRET_ACCESS_KEY|GITHUB_TOKEN|OPENAI_API_KEY|ANTHROPIC_API_KEY)\b[\s\S]{0,80}?(?:curl|fetch|https?:\/\/)/i,
      severity: 'block',
      detail: 'reads a credential and reaches the network nearby',
    },
    {
      rule: 'embedded-secret',
      pattern: /\b(?:sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,})\b/,
      severity: 'block',
      detail: 'contains something shaped like a live credential',
    },
    {
      rule: 'destructive-command',
      pattern: /rm\s+-rf\s+[~/]\S*|\bmkfs\b|\bdd\s+if=/i,
      severity: 'block',
      detail: 'runs a command that destroys data outside the workspace',
    },
    {
      rule: 'unpinned-install',
      pattern: /\b(?:npm|pnpm|yarn)\s+(?:i|install|add)\s+(?!.*@\d)[a-z@][^\n]*/i,
      severity: 'warn',
      detail: 'installs a dependency without a pinned version',
    },
  ];

  for (const rule of rules) {
    if (rule.pattern.test(content)) {
      findings.push({ rule: rule.rule, severity: rule.severity, detail: rule.detail });
    }
  }
  return findings;
}

/** Whether the scan permits signing at all. */
export function scanBlocks(findings: readonly ScanFinding[]): boolean {
  return findings.some((finding) => finding.severity === 'block');
}

/** A human's decision, recorded so the signature can cover it. */
export interface ReviewRecord {
  readonly reviewer: string;
  readonly approved: boolean;
  readonly at: string;
  readonly note?: string | undefined;
}

/**
 * Everything a signature commits to.
 *
 * Serialised with sorted keys and no whitespace, because a signature over a
 * JSON document is a signature over *those bytes* — and two serialisers that
 * disagree about key order produce a valid signature that fails to verify, or
 * worse, a document that can be re-ordered without invalidating it.
 */
export interface SignedRecord {
  readonly name: string;
  readonly version: string;
  readonly contentHash: string;
  readonly review: ReviewRecord;
  readonly findings: readonly ScanFinding[];
  readonly signedAt: string;
}

export function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/** Canonical bytes for signing. Sorted, compact, and the only thing ever signed. */
export function canonicalise(record: SignedRecord): string {
  const ordered = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(ordered);
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, inner]) => [key, ordered(inner)]),
      );
    }
    return value;
  };
  return JSON.stringify(ordered(record));
}

export interface SigningProblem {
  readonly stage: 'review' | 'scan';
  readonly because: string;
}

/**
 * Sign an artifact, or refuse and say which stage stopped it.
 *
 * The two refusals are the pipeline. An unreviewed artifact has nobody's
 * judgement behind it, and a scan-blocked one would have a signature pointing
 * at a known defect.
 */
export function signSkill(input: {
  artifact: SkillArtifact;
  review: ReviewRecord;
  privateKeyPem: string;
  signedAt: string;
}): { record?: SignedRecord; signature?: string; problems: readonly SigningProblem[] } {
  const problems: SigningProblem[] = [];

  if (!input.review.approved) {
    problems.push({ stage: 'review', because: 'the review did not approve this artifact' });
  }

  const findings = scanSkillArtifact(input.artifact);
  if (scanBlocks(findings)) {
    problems.push({
      stage: 'scan',
      because: `blocked by ${findings
        .filter((f) => f.severity === 'block')
        .map((f) => f.rule)
        .join(
          ', ',
        )} — a signature over a known-bad artifact carries authority in the direction of the defect`,
    });
  }

  if (problems.length > 0) return { problems };

  const record: SignedRecord = {
    name: input.artifact.name,
    version: input.artifact.version,
    contentHash: hashContent(input.artifact.content),
    review: input.review,
    findings,
    signedAt: input.signedAt,
  };

  const signature = sign(
    null,
    Buffer.from(canonicalise(record), 'utf8'),
    createPrivateKey(input.privateKeyPem),
  ).toString('base64');

  return { record, signature, problems: [] };
}

export interface VerificationResult {
  /** The key that vouched, when the signature is good. Never a bare boolean. */
  readonly signedBy: string | null;
  readonly contentMatches: boolean;
  readonly signatureValid: boolean;
  readonly problems: readonly string[];
}

/**
 * Verify a signed record against an artifact.
 *
 * Returns *who* signed rather than whether it is safe. A caller that wants a
 * yes/no has to decide which keys it trusts, which is the decision this
 * deliberately refuses to make on their behalf.
 */
export function verifySignature(input: {
  artifact: SkillArtifact;
  record: SignedRecord;
  signature: string;
  publicKeyPem: string;
  keyId: string;
}): VerificationResult {
  const problems: string[] = [];

  // Checked independently of the signature. A record whose signature verifies
  // but whose hash does not match the artifact means somebody swapped the file
  // and kept the paperwork — the failure the hash exists for.
  const contentMatches = hashContent(input.artifact.content) === input.record.contentHash;
  if (!contentMatches) {
    problems.push('the artifact does not match the hash this record was signed over');
  }

  let signatureValid: boolean;
  try {
    signatureValid = verify(
      null,
      Buffer.from(canonicalise(input.record), 'utf8'),
      createPublicKey(input.publicKeyPem),
      Buffer.from(input.signature, 'base64'),
    );
  } catch {
    // A malformed key or signature is an invalid signature, not a crash. This
    // runs over artifacts from strangers.
    signatureValid = false;
  }
  if (!signatureValid) problems.push('the signature does not verify against this key');

  return {
    signedBy: signatureValid && contentMatches ? input.keyId : null,
    contentMatches,
    signatureValid,
    problems,
  };
}
