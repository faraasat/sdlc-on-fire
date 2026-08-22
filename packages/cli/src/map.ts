import fs from 'node:fs/promises';
import path from 'node:path';
import {
  inferredSpecStub,
  isIgnored,
  mapCodebase,
  relativePosix,
  resolveWorkspaceLayout,
  specPath,
  type CodebaseMap,
  type MappedFile,
} from '@sdlc-on-fire/core';

/**
 * `sdlc map` — propose a spec tree from an existing repository (P4-BROWN-02).
 *
 * The on-ramp for a brownfield project. The alternative is a blank `specs/`
 * directory and an instruction to write down what the system does, which is
 * where adoption stops.
 *
 * Writing is opt-in (`--write`) and never clobbers. A mapper that overwrote a
 * spec somebody had started would destroy the exact work it exists to
 * encourage, and it would do it silently — the file is still there, and the
 * words are gone.
 */

export interface MapRunResult {
  readonly map: CodebaseMap;
  readonly written: readonly string[];
  readonly skippedExisting: readonly string[];
  readonly wrote: boolean;
}

async function listFiles(root: string): Promise<MappedFile[]> {
  const out: MappedFile[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      const relative = relativePosix(root, full);
      // Pruned at the directory rather than filtered per file: walking
      // `node_modules` to throw the results away is most of the cost of the
      // walk on any real repository.
      if (isIgnored(relative)) continue;
      if (entry.isDirectory()) await walk(full);
      else out.push({ path: relative });
    }
  };
  await walk(root);
  return out;
}

export async function runMap(
  root: string,
  options: { write?: boolean; maxDomains?: number; includeUnlikely?: boolean } = {},
): Promise<MapRunResult> {
  const layout = resolveWorkspaceLayout(root);
  const files = await listFiles(layout.root);
  const map = mapCodebase(
    files,
    options.maxDomains === undefined ? {} : { maxDomains: options.maxDomains },
  );

  const written: string[] = [];
  const skippedExisting: string[] = [];

  if (options.write === true) {
    // Only what the mapper believes in. An `unlikely` domain is still listed in
    // the report — hiding it would bury a real domain that happens to be badly
    // named — but writing a stub for it costs somebody a file to read and
    // delete, and `--all` is there for when they disagree.
    const toWrite =
      options.includeUnlikely === true
        ? map.domains
        : map.domains.filter((domain) => domain.confidence === 'likely');
    for (const domain of toWrite) {
      const relative = specPath(domain.slug);
      const target = path.join(layout.docsDir, relative);
      await fs.mkdir(path.dirname(target), { recursive: true });
      try {
        // `wx`: the existence check and the write are one operation, so a
        // concurrent run cannot overwrite a spec somebody just started.
        await fs.writeFile(target, inferredSpecStub(domain), { flag: 'wx' });
        written.push(relative);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === 'EEXIST') skippedExisting.push(relative);
        else throw cause;
      }
    }
  }

  return { map, written, skippedExisting, wrote: options.write === true };
}

export function formatMap(result: MapRunResult): string {
  const lines: string[] = [];
  const { domains, filesScanned, skipped } = result.map;

  if (domains.length === 0) {
    lines.push(`Scanned ${String(filesScanned)} file(s) and found no directory with enough source`);
    lines.push('files to propose as a domain. Write the first spec by hand:');
    lines.push('  sdlc spec new <domain>');
    return lines.join('\n');
  }

  lines.push(`${String(domains.length)} proposed domain(s) from ${String(filesScanned)} file(s):`);
  for (const domain of domains) {
    const mark = domain.confidence === 'unlikely' ? '?' : ' ';
    lines.push(`${mark} ${domain.slug.padEnd(20)} ${domain.because}`);
  }
  if (domains.some((domain) => domain.confidence === 'unlikely')) {
    lines.push('');
    lines.push('? — proposed, but the name usually means a pile of helpers. Not written unless');
    lines.push('    you pass --all; listed here because a real domain can be badly named.');
  }

  if (skipped.length > 0) {
    lines.push('');
    for (const entry of skipped) lines.push(`  skipped ${entry.path}: ${entry.because}`);
  }

  lines.push('');
  if (result.wrote) {
    lines.push(`Wrote ${String(result.written.length)} stub(s).`);
    if (result.skippedExisting.length > 0) {
      lines.push(`Left ${String(result.skippedExisting.length)} existing file(s) alone.`);
    }
    lines.push('');
    lines.push('Every stub is marked `inferred: true` and contains no requirement. Nothing here');
    lines.push('has been agreed by anyone — `sdlc spec check` will keep reporting these as');
    lines.push('unconfirmed until you write the requirements and delete the marker.');
  } else {
    lines.push('Nothing written. Re-run with --write to create the stubs.');
  }

  return lines.join('\n');
}
