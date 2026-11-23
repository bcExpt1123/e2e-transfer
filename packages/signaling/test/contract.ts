import type { Signaling } from '@e2e-transfer/core';
import { describe, expect, it } from 'vitest';

/**
 * Contract every Signaling adapter must pass (docs/MAINTAINABILITY.md).
 * `makePair` returns two independent clients that can reach each other.
 */
export function signalingContract(name: string, makePair: () => [Signaling, Signaling]): void {
  const topic = () => `test-${crypto.randomUUID()}`;
  const next = (room: { onMessage(cb: (p: Uint8Array) => void): () => void }) =>
    new Promise<Uint8Array>((resolve) => {
      const off = room.onMessage((p) => {
        off();
        resolve(p);
      });
    });

  describe(`Signaling contract: ${name}`, () => {
    it('delivers bytes between two clients in the same topic', async () => {
      const [a, b] = makePair();
      const t = topic();
      const ra = await a.join(t);
      const rb = await b.join(t);
      const got = next(rb);
      await ra.send(new Uint8Array([1, 2, 3]));
      expect([...(await got)]).toEqual([1, 2, 3]);
      await ra.leave();
      await rb.leave();
    });

    it('does not echo a message back to its sender', async () => {
      const [a, b] = makePair();
      const t = topic();
      const ra = await a.join(t);
      const rb = await b.join(t);
      let echoed = false;
      ra.onMessage(() => {
        echoed = true;
      });
      const got = next(rb);
      await ra.send(new Uint8Array([9]));
      await got;
      expect(echoed).toBe(false);
      await ra.leave();
      await rb.leave();
    });

    it('isolates topics', async () => {
      const [a, b] = makePair();
      const ra = await a.join(topic());
      const rb = await b.join(topic());
      let leaked = false;
      rb.onMessage(() => {
        leaked = true;
      });
      await ra.send(new Uint8Array([7]));
      await new Promise((r) => setTimeout(r, 20));
      expect(leaked).toBe(false);
    });

    it('stops delivery after leave()', async () => {
      const [a, b] = makePair();
      const t = topic();
      const ra = await a.join(t);
      const rb = await b.join(t);
      let received = false;
      rb.onMessage(() => {
        received = true;
      });
      await rb.leave();
      await ra.send(new Uint8Array([1]));
      await new Promise((r) => setTimeout(r, 20));
      expect(received).toBe(false);
    });
  });
}
