/**
 * The WebSocket surface (P3-RT-01).
 *
 * Thin by design. Every decision that matters — what an event is, who should
 * receive it, what a reconnecting client missed — lives in `subscriber`,
 * `fanout` and `catchup`, which are testable without a socket. What is left
 * here is genuinely socket-shaped: accepting a connection, reading a
 * subscription message, and closing down.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { z } from 'zod';
import type { ChangeEvent, Subscription } from '@sdlc-on-fire/core';
import { FanOut } from './fanout.js';
import { catchUp, newestWatermark, type QueryCapable } from './catchup.js';
import { subscribeToChanges, type ListenCapable } from './subscriber.js';

/** What a client may send. Anything else is answered with an error frame. */
const ClientMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('subscribe'),
    tables: z.array(z.string()).optional(),
    ids: z.array(z.string()).optional(),
    /**
     * The newest watermark the client already has. Its presence is what turns a
     * reconnect into a reconcile — without it the server cannot know how far
     * behind the client is, and "since I connected" is the one answer that is
     * always wrong after a dropped connection.
     */
    since: z.string().optional(),
  }),
]);

export interface RealtimeServerOptions {
  readonly db: ListenCapable & QueryCapable;
  /**
   * Optional HTTP handler, tried before the WebSocket upgrade. Returns whether
   * it took the request. Lets the API and the socket share one port — and one
   * loopback guard.
   */
  readonly onRequest?: (request: IncomingMessage, response: ServerResponse) => boolean;
  /** 0 asks the OS for a free port — what tests should use. */
  readonly port?: number;
  readonly host?: string;
  readonly catchUpLimit?: number;
}

export interface RealtimeServer {
  readonly port: number;
  readonly clients: number;
  close(): Promise<void>;
}

type Frame =
  | { type: 'ready'; watermark: string | null }
  | { type: 'change'; event: ChangeEvent }
  | { type: 'catchup'; table: string; rows: readonly Record<string, unknown>[] }
  | { type: 'error'; because: string };

function send(socket: WebSocket, frame: Frame): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame));
}

export async function startRealtimeServer(options: RealtimeServerOptions): Promise<RealtimeServer> {
  const http: Server = createServer((request, response) => {
    if (options.onRequest?.(request, response) === true) return;
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'not found' }));
  });
  const wss = new WebSocketServer({ server: http });
  const fanout = new FanOut();
  let nextId = 0;

  const subscription = await subscribeToChanges({
    db: options.db,
    onEvent: (event) => {
      fanout.deliver(event);
    },
  });

  wss.on('connection', (socket: WebSocket) => {
    const id = `c${String((nextId += 1))}`;

    // Registered immediately with a match-everything subscription. A client
    // that connects and says nothing still gets events, because the opposite
    // default — silence until you subscribe — is indistinguishable from a
    // broken connection from the client's side.
    fanout.add({
      id,
      subscription: {},
      send: (event) => {
        send(socket, { type: 'change', event });
      },
    });

    socket.on('message', (raw: unknown) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(raw));
      } catch {
        send(socket, { type: 'error', because: 'message was not JSON' });
        return;
      }

      const message = ClientMessageSchema.safeParse(parsed);
      if (!message.success) {
        send(socket, { type: 'error', because: message.error.issues[0]?.message ?? 'bad message' });
        return;
      }

      const next: Subscription = {
        ...(message.data.tables === undefined ? {} : { tables: message.data.tables }),
        ...(message.data.ids === undefined ? {} : { ids: message.data.ids }),
      };
      fanout.resubscribe(id, next);

      // The reconcile half. Run before `ready` so a client that waits for
      // `ready` has already been told everything it missed — otherwise there is
      // a window in which it believes it is current and is not.
      void (async () => {
        let watermark: string | null = null;
        if (message.data.since !== undefined) {
          try {
            const missed = await catchUp({
              db: options.db,
              since: message.data.since,
              ...(options.catchUpLimit === undefined ? {} : { limit: options.catchUpLimit }),
              ...(message.data.tables === undefined ? {} : { tables: message.data.tables }),
            });
            for (const result of missed) {
              send(socket, { type: 'catchup', table: result.table, rows: result.rows });
            }
            watermark = newestWatermark(missed) ?? message.data.since;
          } catch (error) {
            send(socket, {
              type: 'error',
              because: `catch-up failed: ${error instanceof Error ? error.message : String(error)}`,
            });
          }
        }
        send(socket, { type: 'ready', watermark });
      })();
    });

    socket.on('close', () => {
      fanout.remove(id);
    });
    socket.on('error', () => {
      fanout.remove(id);
    });
  });

  await new Promise<void>((resolve) => {
    http.listen(options.port ?? 0, options.host ?? '127.0.0.1', resolve);
  });

  const address = http.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  return {
    port,
    get clients() {
      return fanout.size;
    },
    close: async () => {
      await subscription.close();
      for (const socket of wss.clients) socket.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
