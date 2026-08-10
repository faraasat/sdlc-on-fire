import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  resolveSandbox,
  SandboxUnavailableError,
  type SandboxConfig,
  type SandboxResolution,
  type SandboxTier,
} from '@sdlc-on-fire/core';
import { bubblewrapArgs, seatbeltProfile } from './tiers.js';

/**
 * Wrapping the daemon's shell-exec path in the resolved sandbox (P1-SEC-02).
 *
 * The sandbox is a **backstop, not a replacement** for the command classifier
 * (ADR-0036): even when a check misses an obfuscated dangerous command, the
 * boundary holds regardless of what the model chose to run. That is the same
 * structural-over-instructional principle the evidence gate rests on — the
 * control does not depend on the agent cooperating.
 */

const run = promisify(execFile);

/** Whether a tier's facility is actually present on this machine. */
export async function probeSandbox(tier: SandboxTier): Promise<boolean> {
  const binary = tier === 'seatbelt' ? 'sandbox-exec' : tier === 'bubblewrap' ? 'bwrap' : null;
  if (binary === null) return false;
  try {
    // `which` rather than running it: a probe that executed the sandbox would
    // itself need a profile, and a failure would be ambiguous between "missing"
    // and "misconfigured".
    await run('which', [binary]);
    return true;
  } catch {
    return false;
  }
}

export interface SandboxedCommand {
  readonly cmd: string;
  readonly args: readonly string[];
  readonly resolution: SandboxResolution;
  /** Temporary profile to remove after the run, when one was written. */
  readonly cleanup?: (() => Promise<void>) | undefined;
}

/**
 * Rewrites `/bin/sh -c <command>` into its sandboxed equivalent.
 *
 * Returns the command unchanged when no sandbox applies — and says so in
 * `resolution`, so a caller can report the truth instead of implying a boundary.
 * That distinction is the whole reason this returns a resolution rather than
 * just a command.
 */
export async function sandboxCommand(input: {
  readonly command: string;
  readonly workspaceRoot: string;
  readonly config: SandboxConfig;
  readonly platform?: string;
  readonly probe?: (tier: SandboxTier) => Promise<boolean> | boolean;
}): Promise<SandboxedCommand> {
  const platform = input.platform ?? os.platform();
  const probe = input.probe ?? probeSandbox;

  // Resolution is synchronous and pure; the probe result is fetched first so the
  // decision itself stays testable without the facility being installed.
  const candidate = input.config.tier;
  const probed =
    candidate === 'none' ? false : await Promise.resolve(probe(candidate)).catch(() => false);
  const resolution = resolveSandbox(input.config, platform, () => probed);

  if (!resolution.available && input.config.required) {
    throw new SandboxUnavailableError(resolution);
  }

  if (resolution.tier === 'seatbelt') {
    // The profile lives in its own directory, and that directory is the only
    // temp the sandboxed process may write to. Handing it the whole of `/tmp`
    // was the first version's mistake.
    const sandboxTmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sdlcof-sb-')));
    const profilePath = path.join(sandboxTmp, 'profile.sb');
    await fs.writeFile(
      profilePath,
      seatbeltProfile(input.config, input.workspaceRoot, sandboxTmp),
      'utf8',
    );
    return {
      cmd: 'sandbox-exec',
      args: ['-f', profilePath, '/bin/sh', '-c', input.command],
      resolution,
      cleanup: async () => {
        await fs.rm(sandboxTmp, { recursive: true, force: true });
      },
    };
  }

  if (resolution.tier === 'bubblewrap') {
    return {
      cmd: 'bwrap',
      args: [...bubblewrapArgs(input.config, input.workspaceRoot), '/bin/sh', '-c', input.command],
      resolution,
    };
  }

  return { ...unsandboxedShell(input.command, platform), resolution };
}

/**
 * The unsandboxed shell for a platform.
 *
 * `/bin/sh` does not exist on native Windows, so the untiered path — which is
 * every Windows host, since seatbelt is macOS and bubblewrap is Linux — could
 * not execute a verify command at all. `sdlc verify` is the gate, so the
 * product's entire point was inoperable there while every test passed on
 * Linux CI (Q-02, [ADR-0072](docs/.plan/decisions/ADR-0072-windows-native-support-tier.md)).
 *
 * `cmd.exe /d /s /c` rather than PowerShell: it is the shell Node's own
 * `child_process` uses for `shell: true` on Windows, so a `verify:` command
 * that works when a user pastes it into their terminal behaves the same here.
 * `/d` skips AutoRun registry commands — a machine-local script silently
 * prepended to every verify would be evidence about a command nobody declared.
 */
export function unsandboxedShell(
  command: string,
  platform: string = os.platform(),
): { readonly cmd: string; readonly args: readonly string[] } {
  return platform === 'win32'
    ? { cmd: process.env['ComSpec'] ?? 'cmd.exe', args: ['/d', '/s', '/c', command] }
    : { cmd: '/bin/sh', args: ['-c', command] };
}
