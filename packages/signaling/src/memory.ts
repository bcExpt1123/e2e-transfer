import type { Signaling, SignalingRoom } from '@e2e-transfer/core';

/**
 * In-process signaling hub for tests and local development.
 * Every `MemorySignaling` created from the same hub shares rooms;
 * like real relays, a sender does not receive its own messages.
 */
export class MemorySignalingHub {
  readonly #rooms = new Map<string, Set<(payload: Uint8Array, from: object) => void>>();

  client(): Signaling {
    const hub = this.#rooms;
    const self = {};
    return {
      id: 'memory',
      async join(topic: string): Promise<SignalingRoom> {
        let room = hub.get(topic);
        if (!room) {
          room = new Set();
          hub.set(topic, room);
        }
        const members = room;
        const mine = new Set<(payload: Uint8Array, from: object) => void>();
        return {
          async send(payload) {
            const copy = payload.slice();
            for (const deliver of [...members]) deliver(copy, self);
          },
          onMessage(cb) {
            const deliver = (payload: Uint8Array, from: object) => {
              if (from !== self) queueMicrotask(() => cb(payload));
            };
            members.add(deliver);
            mine.add(deliver);
            return () => {
              members.delete(deliver);
              mine.delete(deliver);
            };
          },
          async leave() {
            for (const deliver of mine) members.delete(deliver);
            mine.clear();
          },
        };
      },
    };
  }
}
