import { ErrorCode, type Signaling, type SignalingRoom, TransferError } from '@e2e-transfer/core';

/**
 * Uses several signaling networks at once (docs/ARCHITECTURE.md § Why this scales).
 * Both peers join every network in parallel, so they meet even when one network is
 * blocked for just one of them — a sequential fallback could strand them on different ones.
 * Duplicate deliveries are fine: core's envelope drops repeated (from, seq) pairs.
 */
export function multiSignaling(networks: readonly Signaling[]): Signaling {
  if (networks.length === 0) throw new RangeError('multiSignaling: no networks');
  if (networks.length === 1 && networks[0]) return networks[0];
  return {
    id: networks.map((n) => n.id).join('+'),
    async join(topic: string): Promise<SignalingRoom> {
      const rooms = new Set<SignalingRoom>();
      const listeners = new Set<(p: Uint8Array) => void>();
      let left = false;
      const attach = (room: SignalingRoom) => {
        if (left) {
          void room.leave().catch(() => {});
          return room;
        }
        rooms.add(room);
        room.onMessage((p) => {
          for (const cb of [...listeners]) cb(p);
        });
        return room;
      };
      const attempts = networks.map((n) => n.join(topic).then(attach));
      for (const a of attempts) a.catch(() => {});
      try {
        await Promise.any(attempts);
      } catch (err) {
        const first = (err as AggregateError).errors?.[0];
        throw first instanceof TransferError
          ? first
          : new TransferError(ErrorCode.SignalingUnreachable, 'no signaling network reachable', {
              cause: err,
            });
      }
      return {
        async send(payload) {
          const results = await Promise.allSettled([...rooms].map((r) => r.send(payload)));
          const failure = results.find((r) => r.status === 'rejected');
          if (failure && results.every((r) => r.status === 'rejected')) throw failure.reason;
        },
        onMessage(cb) {
          listeners.add(cb);
          return () => listeners.delete(cb);
        },
        async leave() {
          left = true;
          listeners.clear();
          await Promise.allSettled([...rooms].map((r) => r.leave()));
          rooms.clear();
        },
      };
    },
  };
}
