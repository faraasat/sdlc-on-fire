/**
 * Staying live (P3-UI-01, over P3-RT-01's server).
 *
 * A change event says a row moved; it does not say what the row now is. So this
 * invalidates the affected queries and lets TanStack Query refetch — the same
 * path a first load takes, which means there is exactly one description of how
 * the board is built, and a live update cannot disagree with a reload.
 *
 * The watermark is the correctness-critical part. Postgres keeps nothing for a
 * listener that is absent, so on every reconnect the client sends the newest
 * timestamp it has seen and the server replays the gap. Without it a dropped
 * connection leaves a board that looks fine and is wrong.
 */

import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ChangeEvent } from '@sdlc-on-fire/core/browser';
import { keysForTable } from './queries.js';
import { useUiStore } from '../state/ui.js';

type ServerFrame =
  | { type: 'ready'; watermark: string | null }
  | { type: 'change'; event: ChangeEvent }
  | { type: 'catchup'; table: string; rows: Record<string, unknown>[] }
  | { type: 'error'; because: string };

/** Backoff for reconnection, capped so a long outage does not become a long wait. */
export function backoffMs(attempt: number, cap = 15_000): number {
  return Math.min(cap, 500 * 2 ** Math.max(0, attempt - 1));
}

export function socketUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws`;
}

export function useRealtime(): void {
  const queryClient = useQueryClient();
  const watermark = useRef<string | null>(null);
  const attempt = useRef(0);
  const setConnection = useUiStore((state) => state.setConnection);

  useEffect(() => {
    let socket: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    const invalidate = (table: string, id: string): void => {
      for (const key of keysForTable(table, id)) {
        void queryClient.invalidateQueries({ queryKey: key });
      }
    };

    const connect = (): void => {
      if (closed) return;
      setConnection(attempt.current === 0 ? 'connecting' : 'reconnecting');
      socket = new WebSocket(socketUrl());

      socket.onopen = () => {
        attempt.current = 0;
        setConnection('live');
        socket?.send(
          JSON.stringify({
            type: 'subscribe',
            // Sent on every connect, not only on the first. This is what turns
            // a reconnect into a reconcile.
            ...(watermark.current === null ? {} : { since: watermark.current }),
          }),
        );
      };

      socket.onmessage = (message: MessageEvent) => {
        let frame: ServerFrame;
        try {
          frame = JSON.parse(String(message.data)) as ServerFrame;
        } catch {
          return;
        }

        if (frame.type === 'change') {
          if (watermark.current === null || frame.event.updated_at > watermark.current) {
            watermark.current = frame.event.updated_at;
          }
          invalidate(frame.event.table, frame.event.id);
          return;
        }

        if (frame.type === 'catchup') {
          // The rows are carried in the frame, but they are still only used to
          // trigger a refetch. Writing them into the cache directly would be a
          // second way to build the board, and two ways disagree eventually.
          for (const row of frame.rows) {
            const id = row['id'];
            invalidate(frame.table, typeof id === 'string' ? id : '');
            const stamp = row['updated_at'] ?? row['created_at'];
            if (
              typeof stamp === 'string' &&
              (watermark.current === null || stamp > watermark.current)
            ) {
              watermark.current = stamp;
            }
          }
          return;
        }

        if (frame.type === 'ready' && frame.watermark !== null) {
          watermark.current = frame.watermark;
        }
      };

      const retry = (): void => {
        if (closed) return;
        setConnection('reconnecting');
        attempt.current += 1;
        timer = setTimeout(connect, backoffMs(attempt.current));
      };

      socket.onclose = retry;
      socket.onerror = () => socket?.close();
    };

    connect();

    return () => {
      closed = true;
      setConnection('offline');
      if (timer !== null) clearTimeout(timer);
      socket?.close();
    };
  }, [queryClient, setConnection]);
}
