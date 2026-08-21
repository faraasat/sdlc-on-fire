/**
 * Subscription-scoped fan-out (P3-RT-01).
 *
 * Transport-agnostic on purpose. A client here is anything with a `send`, so
 * the routing rules — who gets which event — are testable without a socket,
 * and the WebSocket layer is left with nothing to decide.
 */

import { matchesSubscription, type ChangeEvent, type Subscription } from '@sdlc-on-fire/core';

export interface Client {
  readonly id: string;
  subscription: Subscription;
  send(event: ChangeEvent): void;
}

export interface FanOutStats {
  readonly delivered: number;
  readonly skipped: number;
  readonly failed: number;
}

/** A registry of connected clients and the routing of events to them. */
export class FanOut {
  private readonly clients = new Map<string, Client>();

  add(client: Client): void {
    this.clients.set(client.id, client);
  }

  remove(id: string): void {
    this.clients.delete(id);
  }

  get size(): number {
    return this.clients.size;
  }

  /** Update what an already-connected client wants, without reconnecting it. */
  resubscribe(id: string, subscription: Subscription): boolean {
    const client = this.clients.get(id);
    if (client === undefined) return false;
    client.subscription = subscription;
    return true;
  }

  /**
   * Deliver one event to every client whose subscription matches.
   *
   * A client whose `send` throws is dropped rather than retried: a socket that
   * has failed once will fail for every subsequent event, and keeping it would
   * turn one dead connection into a per-event exception for the lifetime of the
   * daemon.
   */
  deliver(event: ChangeEvent): FanOutStats {
    let delivered = 0;
    let skipped = 0;
    let failed = 0;

    for (const client of [...this.clients.values()]) {
      if (!matchesSubscription(event, client.subscription)) {
        skipped += 1;
        continue;
      }
      try {
        client.send(event);
        delivered += 1;
      } catch {
        failed += 1;
        this.clients.delete(client.id);
      }
    }

    return { delivered, skipped, failed };
  }
}
