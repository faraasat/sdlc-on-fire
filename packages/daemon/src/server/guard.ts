/**
 * Who is allowed to talk to a local daemon (P3-UI-01).
 *
 * Binding to 127.0.0.1 feels like a boundary and is not one. DNS rebinding
 * turns a loopback-only server into a remotely reachable one: an attacker's
 * page loads from their domain, the DNS record is then rebound to 127.0.0.1,
 * and every subsequent request reaches the victim's local server while the
 * browser still considers it same-origin. The page can then read whatever the
 * daemon serves — in this product, an entire project's work items, evidence and
 * comments.
 *
 * The documented mitigation is to validate the `Host` header against an
 * allowlist of loopback names, and it is the cheapest effective one because the
 * attacker's page cannot forge `Host`: the browser sets it from the name it
 * resolved, which is the attacker's domain, not `localhost`.
 */

/** Host values a loopback-bound daemon should answer to. */
export const LOOPBACK_HOSTS: readonly string[] = ['localhost', '127.0.0.1', '[::1]', '::1'];

/**
 * Whether a `Host` header names this machine's loopback interface.
 *
 * The port is stripped before comparison but IPv6 literals keep their brackets,
 * because `[::1]:3000` splits on `:` in a way that a naive `split(':')[0]`
 * turns into `[`.
 */
export function isLoopbackHost(host: string | undefined): boolean {
  if (host === undefined || host === '') return false;

  const trimmed = host.trim().toLowerCase();
  const bracketed = trimmed.startsWith('[');
  const name = bracketed
    ? (trimmed.match(/^\[[^\]]*\]/)?.[0] ?? trimmed)
    : (trimmed.split(':')[0] ?? trimmed);

  return LOOPBACK_HOSTS.includes(name);
}

/**
 * Whether an `Origin` may make a cross-origin request to the daemon.
 *
 * The Vite dev server runs on a different port, so some cross-origin access is
 * required and a blanket `*` is not an option: `*` would let every page on the
 * internet read the board. Loopback origins only, any port.
 */
export function isAllowedOrigin(origin: string | undefined): boolean {
  if (origin === undefined || origin === '') return false;
  try {
    const url = new URL(origin);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    return isLoopbackHost(url.host);
  } catch {
    return false;
  }
}
