/**
 * Serving the built board (P3-UI-01).
 *
 * Same origin, same port as the API and the WebSocket. That is a security
 * property rather than a packaging convenience: one origin means the loopback
 * guard covers the whole surface and there is no second place a CORS rule could
 * be loosened. It is also why the app never learns a base URL — in production
 * there is nothing to configure, and in development Vite proxies.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isLoopbackHost } from './guard.js';

const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

/**
 * Resolve a URL path to a file inside `root`, or null.
 *
 * The traversal check is the point. `path.join(root, '../../etc/passwd')`
 * escapes happily, so the resolved path is compared against the root prefix
 * afterwards — checking the *input* for `..` is the version that gets bypassed
 * by encoding.
 */
export function resolveAsset(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath.split('?')[0] ?? '/');
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;

  const candidate = path.resolve(root, `.${decoded.startsWith('/') ? decoded : `/${decoded}`}`);
  const rootWithSep = path.resolve(root) + path.sep;
  if (candidate !== path.resolve(root) && !candidate.startsWith(rootWithSep)) return null;
  return candidate;
}

export function createStaticHandler(
  root: string,
): (request: IncomingMessage, response: ServerResponse) => boolean {
  return (request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return false;
    if (!isLoopbackHost(request.headers.host)) {
      response.writeHead(403).end('host not allowed');
      return true;
    }

    void (async () => {
      const urlPath = (request.url ?? '/').split('?')[0] ?? '/';
      let file = resolveAsset(root, urlPath === '/' ? '/index.html' : urlPath);

      if (file === null) {
        response.writeHead(403).end('forbidden');
        return;
      }

      let body: Buffer | null = null;
      try {
        const stat = await fs.stat(file);
        if (stat.isDirectory()) file = path.join(file, 'index.html');
        body = await fs.readFile(file);
      } catch {
        // Single-page app: an unknown path is a client route, not a 404 — but
        // only for paths that do not look like a file, so a missing asset still
        // reports as missing instead of silently returning HTML.
        if (path.extname(urlPath) === '') {
          try {
            body = await fs.readFile(path.join(root, 'index.html'));
            file = path.join(root, 'index.html');
          } catch {
            body = null;
          }
        }
      }

      if (body === null) {
        response.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
        return;
      }

      response.writeHead(200, {
        'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream',
        // Hashed asset names make long caching safe; index.html must not be
        // cached or a deploy is invisible until a hard refresh.
        'cache-control': file.endsWith('index.html')
          ? 'no-store'
          : 'public, max-age=31536000, immutable',
        'x-content-type-options': 'nosniff',
      });
      response.end(request.method === 'HEAD' ? undefined : body);
    })();
    return true;
  };
}
