import { z } from 'zod';
import { ResourceLimitsSchema } from './resource-limits.js';

/**
 * Sandbox tiers for the daemon's shell-exec path (P1-SEC-02, ADR-0036).
 *
 * The daemon runs commands an agent chose. Worktree-per-task isolates *working
 * directories* from each other; it has never isolated *processes* from the host,
 * and the gap between those is the whole of this module.
 *
 * **The honest claim is blast radius, not prevention.** bubblewrap and Seatbelt
 * share a kernel with the host, and ADR-0036 records a 2026 report of Claude
 * Code escaping its own bubblewrap sandbox. This raises the cost of a breakout
 * and bounds the damage of an ordinary mistake. Stating that plainly matters
 * more than usual here, because a security control people over-trust is worse
 * than one they know the shape of.
 *
 * **It never degrades silently.** A sandbox that quietly becomes no sandbox is
 * the worst outcome available: the command runs, everything looks normal, and
 * the user believes a boundary exists. `resolveSandbox` reports what it can
 * actually provide and why, and the caller decides — with `required`, an absent
 * facility is a refusal rather than a shrug.
 */

export const SANDBOX_TIERS = ['none', 'seatbelt', 'bubblewrap'] as const;
export const SandboxTierSchema = z.enum(SANDBOX_TIERS);
export type SandboxTier = z.infer<typeof SandboxTierSchema>;

/**
 * Filesystem × network × credentials, each independently controllable
 * (ADR-0036, following the shape of a shipped production reference).
 *
 * v0.1 implements the filesystem dimension. Network and credentials are
 * *declared* here and reported as unenforced rather than omitted: a config key
 * that silently does nothing is the failure this project keeps finding in
 * itself, and the two remaining dimensions are P1-SEC-03's work.
 */
export const SandboxConfigSchema = z
  .object({
    /** Highest tier to attempt. `none` disables sandboxing entirely. */
    tier: SandboxTierSchema.default('none'),
    /**
     * Refuse to run when the requested tier is unavailable.
     *
     * Off by default, because turning a missing facility into a hard failure on
     * a machine that never asked for sandboxing would break the tool for people
     * who are not using this feature. On, it is the difference between a control
     * and a suggestion.
     */
    required: z.boolean().default(false),
    filesystem: z
      .object({
        /** Absolute paths the sandboxed process may write to. */
        allowWrite: z.array(z.string().min(1)).default([]),
        /** Absolute paths it may not, even inside an allowed subtree. */
        denyWrite: z.array(z.string().min(1)).default([]),
      })
      .prefault({}),
    /** Declared, not yet enforced — P1-SEC-03. Reported as such. */
    network: z.object({ allowedDomains: z.array(z.string().min(1)).default([]) }).prefault({}),
    /**
     * Credentials the sandboxed process must not hold (P1-SEC-03).
     *
     * `envVars` are replaced with per-session sentinels — a command that
     * exfiltrates its whole environment exfiltrates worthless strings. `files`
     * is still declared-and-unenforced: masking a file needs the egress proxy
     * that substitutes the real value back, and that proxy is not built.
     */
    credentials: z
      .object({
        files: z.array(z.string().min(1)).default([]),
        envVars: z.array(z.string().min(1)).default([]),
      })
      .prefault({}),
    /** Wall-clock, output and (Linux) memory bounds for a run (P1-SEC-04). */
    limits: ResourceLimitsSchema,
  })
  .strict()
  .prefault({});

export type SandboxConfig = z.infer<typeof SandboxConfigSchema>;

export interface SandboxResolution {
  /** What will actually be applied — never more than what is available. */
  readonly tier: SandboxTier;
  /** What was asked for. Differs from `tier` when the facility is missing. */
  readonly requested: SandboxTier;
  readonly available: boolean;
  /** Plain-language reason, always present, including on success. */
  readonly reason: string;
  /** Dimensions declared in config that this build does not enforce. */
  readonly unenforced: readonly string[];
}

/** The tier this platform can offer, ignoring what was asked for. */
export function tierForPlatform(platform: string): SandboxTier {
  if (platform === 'darwin') return 'seatbelt';
  if (platform === 'linux') return 'bubblewrap';
  // No native Windows sandbox exists to build against today; ADR-0036's
  // Windows story is "run inside WSL2", which reports itself as linux.
  return 'none';
}

/**
 * Decides what sandboxing this run actually gets.
 *
 * `probe` is injected so this stays a pure decision: whether `sandbox-exec` is
 * on the PATH is an I/O question, and mixing it in here would make the rule
 * untestable without the facility being present or absent on the test machine.
 */
export function resolveSandbox(
  config: SandboxConfig,
  platform: string,
  probe: (tier: SandboxTier) => boolean,
): SandboxResolution {
  const unenforced: string[] = [];
  if (config.network.allowedDomains.length > 0) unenforced.push('network.allowedDomains');
  // `envVars` masking is enforced (P1-SEC-03); `files` masking still needs the
  // egress proxy, so only that half is reported unenforced. Reporting both
  // would have understated what is actually in force, which is its own kind of
  // dishonesty.
  if (config.credentials.files.length > 0) unenforced.push('credentials.files');

  if (config.tier === 'none') {
    return {
      tier: 'none',
      requested: 'none',
      available: true,
      reason: "sandboxing is off — commands run with the daemon's own privileges",
      unenforced,
    };
  }

  const platformTier = tierForPlatform(platform);
  if (platformTier === 'none') {
    return {
      tier: 'none',
      requested: config.tier,
      available: false,
      reason: `no sandbox facility exists for platform "${platform}" — on Windows, run inside WSL2 (ADR-0036)`,
      unenforced,
    };
  }
  if (config.tier !== platformTier) {
    return {
      tier: 'none',
      requested: config.tier,
      available: false,
      reason: `"${config.tier}" is not the sandbox for "${platform}" — that platform provides "${platformTier}"`,
      unenforced,
    };
  }
  if (!probe(platformTier)) {
    return {
      tier: 'none',
      requested: config.tier,
      available: false,
      reason: `"${platformTier}" is configured but not present on this machine`,
      unenforced,
    };
  }

  return {
    tier: platformTier,
    requested: config.tier,
    available: true,
    reason: `${platformTier} confines filesystem writes; this bounds blast radius and is not a hard boundary against a determined exploit`,
    unenforced,
  };
}

export class SandboxUnavailableError extends Error {
  override readonly name = 'SandboxUnavailableError';
  constructor(resolution: SandboxResolution) {
    super(
      `sandbox.required is set and the sandbox is unavailable: ${resolution.reason}. ` +
        'Refusing to run the command unsandboxed — running it anyway would leave you believing ' +
        'a boundary exists that does not.',
    );
  }
}
