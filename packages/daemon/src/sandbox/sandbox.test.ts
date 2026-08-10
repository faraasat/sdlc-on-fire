import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  resolveSandbox,
  SandboxConfigSchema,
  SandboxUnavailableError,
  tierForPlatform,
  type SandboxConfig,
} from '@sdlc-on-fire/core';
import { probeSandbox, sandboxCommand, unsandboxedShell } from './exec.js';
import { bubblewrapArgs, seatbeltProfile } from './tiers.js';

/**
 * Sandbox tiers (P1-SEC-02, ADR-0036).
 *
 * The enforcement test runs a **real** `sandbox-exec` on macOS and asserts a
 * write outside the workspace is actually refused. A test that only checked the
 * generated profile string would prove the profile matches my idea of Seatbelt's
 * syntax — which is precisely the assumption most likely to be wrong, and a
 * wrong security control is worse than a missing one because people rely on it.
 */

const run = promisify(execFile);
const config = (over: Partial<SandboxConfig> = {}): SandboxConfig =>
  SandboxConfigSchema.parse({ ...over });

describe('choosing a tier', () => {
  it('maps each platform to the facility it actually has', () => {
    expect(tierForPlatform('darwin')).toBe('seatbelt');
    expect(tierForPlatform('linux')).toBe('bubblewrap');
    // No native Windows sandbox exists to build against; ADR-0036's answer is
    // "run inside WSL2", which reports itself as linux.
    expect(tierForPlatform('win32')).toBe('none');
  });

  it('never claims a sandbox it cannot provide', () => {
    // The worst outcome available is a control that silently is not there: the
    // command runs, everything looks normal, and the user believes a boundary
    // exists.
    const resolution = resolveSandbox(config({ tier: 'seatbelt' }), 'darwin', () => false);
    expect(resolution.tier).toBe('none');
    expect(resolution.available).toBe(false);
    expect(resolution.reason).toMatch(/not present on this machine/);
  });

  it('refuses the wrong tier for the platform rather than substituting one', () => {
    const resolution = resolveSandbox(config({ tier: 'bubblewrap' }), 'darwin', () => true);
    expect(resolution.tier).toBe('none');
    expect(resolution.reason).toMatch(/that platform provides "seatbelt"/);
  });

  it('states its own limits when it does apply', () => {
    // A security control people over-trust is worse than one whose shape they
    // know. Shared-kernel sandboxes are not a hard boundary (ADR-0036).
    const resolution = resolveSandbox(config({ tier: 'seatbelt' }), 'darwin', () => true);
    expect(resolution.tier).toBe('seatbelt');
    expect(resolution.reason).toMatch(/not a hard boundary/);
  });

  it('names config dimensions this build does not enforce', () => {
    // A config key that silently does nothing is the failure this project keeps
    // finding in itself. Network and credentials are P1-SEC-03.
    const resolution = resolveSandbox(
      config({ tier: 'none', network: { allowedDomains: ['example.test'] } }),
      'darwin',
      () => true,
    );
    expect(resolution.unenforced).toContain('network.allowedDomains');
  });
});

describe('when the sandbox is required', () => {
  it('refuses to run unsandboxed rather than running anyway', async () => {
    await expect(
      sandboxCommand({
        command: 'echo hi',
        workspaceRoot: '/tmp',
        config: config({ tier: 'bubblewrap', required: true }),
        platform: 'darwin',
        probe: () => true,
      }),
    ).rejects.toBeInstanceOf(SandboxUnavailableError);
  });

  it('runs unsandboxed but says so when it is not required', async () => {
    const result = await sandboxCommand({
      command: 'echo hi',
      workspaceRoot: '/tmp',
      config: config({ tier: 'bubblewrap' }),
      platform: 'darwin',
      probe: () => true,
    });
    expect(result.cmd).toBe('/bin/sh');
    expect(result.resolution.available).toBe(false);
  });
});

describe('the generated profile', () => {
  it('escapes a path that would otherwise break out of the s-expression', () => {
    // A workspace path containing a quote would terminate the expression early
    // and produce a profile that silently permits more than intended.
    const profile = seatbeltProfile(config(), '/tmp/we"ird', '/tmp/sb');
    expect(profile).toContain('\\"');
    expect(
      profile.split('\n').filter((line) => line.startsWith('(allow file-write*')).length,
    ).toBeGreaterThan(0);
  });

  it('binds only the declared paths writable under bubblewrap', () => {
    const args = bubblewrapArgs(
      config({ filesystem: { allowWrite: ['/opt/cache'], denyWrite: [] } }),
      '/work',
    );
    expect(args).toContain('--ro-bind');
    expect(args.join(' ')).toContain('--bind /work /work');
    expect(args.join(' ')).toContain('--bind /opt/cache /opt/cache');
  });
});

describe('real enforcement', () => {
  const onMac = os.platform() === 'darwin';

  it.runIf(onMac)(
    'actually refuses a write outside the workspace',
    async () => {
      if (!(await probeSandbox('seatbelt'))) return;

      const workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sb-work-')));
      const outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sb-out-')));
      try {
        const inside = await sandboxCommand({
          command: `echo ok > ${workspace}/inside.txt`,
          workspaceRoot: workspace,
          config: config({ tier: 'seatbelt' }),
        });
        expect(inside.resolution.tier).toBe('seatbelt');
        await run(inside.cmd, [...inside.args]);
        await inside.cleanup?.();
        // The workspace stays writable — a sandbox that broke the build would be
        // switched off within a day and protect nothing.
        await expect(fs.readFile(path.join(workspace, 'inside.txt'), 'utf8')).resolves.toContain(
          'ok',
        );

        const escape = await sandboxCommand({
          command: `echo pwned > ${outside}/escaped.txt`,
          workspaceRoot: workspace,
          config: config({ tier: 'seatbelt' }),
        });
        await expect(run(escape.cmd, [...escape.args])).rejects.toThrow();
        await escape.cleanup?.();
        await expect(fs.stat(path.join(outside, 'escaped.txt'))).rejects.toThrow();
      } finally {
        await fs.rm(workspace, { recursive: true, force: true });
        await fs.rm(outside, { recursive: true, force: true });
      }
    },
    120_000,
  );

  it.runIf(onMac)(
    'removes the temporary profile it wrote',
    async () => {
      if (!(await probeSandbox('seatbelt'))) return;
      const sandboxed = await sandboxCommand({
        command: 'true',
        workspaceRoot: os.tmpdir(),
        config: config({ tier: 'seatbelt' }),
      });
      const profilePath = sandboxed.args[1] ?? '';
      await sandboxed.cleanup?.();
      await expect(fs.stat(profilePath)).rejects.toThrow();
    },
    120_000,
  );
});

describe('the unsandboxed shell (Q-02 — native Windows)', () => {
  it('uses /bin/sh on posix', () => {
    expect(unsandboxedShell('pnpm test', 'darwin')).toEqual({
      cmd: '/bin/sh',
      args: ['-c', 'pnpm test'],
    });
    expect(unsandboxedShell('pnpm test', 'linux').cmd).toBe('/bin/sh');
  });

  it('uses the Windows command processor on win32', () => {
    // `/bin/sh` does not exist on native Windows, and the untiered path is every
    // Windows host — seatbelt is macOS, bubblewrap is Linux. So `sdlc verify`
    // could not execute a command at all there: the gate, which is the product's
    // whole point, was inoperable while Linux CI stayed green.
    const shell = unsandboxedShell('pnpm test', 'win32');
    expect(shell.cmd.toLowerCase()).toContain('cmd');
    expect(shell.args).toEqual(['/d', '/s', '/c', 'pnpm test']);
  });

  it('skips AutoRun, so no machine-local script joins the command', () => {
    // A registry AutoRun entry prepends itself to every cmd.exe invocation.
    // Without /d, the evidence would describe a command nobody declared.
    expect(unsandboxedShell('x', 'win32').args).toContain('/d');
  });
});
