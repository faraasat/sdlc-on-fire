import { createHash } from 'node:crypto';

/**
 * Content hashing, defined once so every subsystem agrees on what "unchanged"
 * means.
 *
 * The sync loop-guard, the DB mirror's `content_hash` columns, and the evidence
 * envelope's `content_hash` all compare these values. Two implementations that
 * differ by a trailing newline would make the watcher re-process every file
 * forever, so there is exactly one.
 */

/** sha256 of file content, hex-encoded. Line endings are normalised first. */
export function contentHash(content: string): string {
  return createHash('sha256').update(content.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

/**
 * sha256 over a canonical (stable-key-order) JSON serialization.
 *
 * Used for the evidence envelope's `content_hash`, where two structurally equal
 * payloads must hash equal regardless of key insertion order.
 */
export function canonicalJsonHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}
