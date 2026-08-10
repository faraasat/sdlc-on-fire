import { z } from 'zod';

/**
 * Resource limits and the watchdog for the shell-exec path (P1-SEC-04, ADR-0036).
 *
 * A runaway `npm install` or a test suite that deadlocks does not need to be
 * malicious to take the machine down. This bounds three things — wall clock,
 * output volume, and (where the OS provides it) memory — and kills the whole
 * process *group* rather than the process.
 *
 * **The group is the whole point.** ADR-0036 names subprocess inheritance as a
 * correctness requirement rather than a nicety: `pnpm test` spawns Vitest, which
 * spawns workers, and killing only the process you launched leaves the actual
 * work running with its parent gone. A timeout that leaves the runaway running
 * has done nothing except make the daemon stop watching it.
 *
 * **What is enforced is reported.** cgroups exist on Linux and not on macOS, so
 * a memory cap is honoured on one and cannot be on the other. Saying so beats
 * implying a limit that is not there — the same rule the sandbox tiers follow.
 */

export const ResourceLimitsSchema = z
  .object({
    /** Wall clock, in seconds. The only limit enforceable everywhere. */
    timeoutSeconds: z.number().int().positive().default(600),
    /**
     * Maximum captured output, in bytes.
     *
     * A command printing without bound fills memory in the *daemon*, not in the
     * child — so this is a limit on us, and it is the one most likely to fire in
     * ordinary use.
     */
    maxOutputBytes: z
      .number()
      .int()
      .positive()
      .default(32 * 1024 * 1024),
    /** Memory cap in MB. Linux only; reported as unenforced elsewhere. */
    memoryMb: z.number().int().positive().optional(),
  })
  .strict()
  .prefault({});

export type ResourceLimits = z.infer<typeof ResourceLimitsSchema>;
