import type { Signaling, SignalingRoom } from '@e2e-transfer/core';

/**
 * Signaling between tabs of the same browser profile via BroadcastChannel.
 * Used by the Playwright e2e tests (no public relays) and handy for local demos.
 * A BroadcastChannel never delivers to the instance that posted, which gives "no echo" for free.
 */
export function broadcastSignaling(prefix = 'e2e-transfer/v1'): Signaling {
  return {
    id: 'broadcast',
    async join(topic: string): Promise<SignalingRoom> {
      const bc = new BroadcastChannel(`${prefix}:${topic}`);
      const listeners = new Set<(payload: Uint8Array) => void>();
      bc.onmessage = (e: MessageEvent) => {
        if (!(e.data instanceof Uint8Array)) return;
        for (const cb of [...listeners]) cb(e.data);
      };
      let open = true;
      return {
        async send(payload) {
          if (open) bc.postMessage(payload);
        },
        onMessage(cb) {
          listeners.add(cb);
          return () => listeners.delete(cb);
        },
        async leave() {
          open = false;
          listeners.clear();
          bc.close();
        },
      };
    },
  };
}
