import { ErrorCode, type Signaling, TransferError } from '@e2e-transfer/core';
import { describe, expect, it } from 'vitest';
import { MemorySignalingHub, multiSignaling } from '../src/index.ts';
import { signalingContract } from './contract.ts';

signalingContract('multi', () => {
  const h1 = new MemorySignalingHub();
  const h2 = new MemorySignalingHub();
  return [multiSignaling([h1.client(), h2.client()]), multiSignaling([h1.client(), h2.client()])];
});

const broken = (id = 'broken'): Signaling => ({
  id,
  join: () => Promise.reject(new TransferError(ErrorCode.SignalingUnreachable, `${id} down`)),
});

describe('multiSignaling', () => {
  it('connects peers that share at least one working network', async () => {
    const shared = new MemorySignalingHub();
    // sender's first network is down; receiver lacks the second one entirely
    const a = multiSignaling([broken('nostr'), shared.client()]);
    const b = multiSignaling([new MemorySignalingHub().client(), shared.client()]);
    expect(a.id).toBe('nostr+memory');
    const ra = await a.join('t');
    const rb = await b.join('t');
    const got = new Promise<Uint8Array>((resolve) => rb.onMessage(resolve));
    await ra.send(Uint8Array.of(9));
    expect(await got).toEqual(Uint8Array.of(9));
    await ra.leave();
    await rb.leave();
  });

  it('fails with the first network’s reason when all are down', async () => {
    await expect(multiSignaling([broken('x'), broken('y')]).join('t')).rejects.toThrow('x down');
    const plain: Signaling = { id: 'p', join: () => Promise.reject(new Error('boom')) };
    await expect(multiSignaling([plain, plain]).join('t')).rejects.toMatchObject({
      code: 'SIGNALING_UNREACHABLE',
    });
  });

  it('passes a single network through and rejects an empty list', () => {
    const one = new MemorySignalingHub().client();
    expect(multiSignaling([one])).toBe(one);
    expect(() => multiSignaling([])).toThrow(RangeError);
  });

  it('only fails a send when every network fails', async () => {
    const hub = new MemorySignalingHub();
    const failing: Signaling = {
      id: 'f',
      join: async () => ({
        send: () => Promise.reject(new Error('send failed')),
        onMessage: () => () => {},
        leave: async () => {},
      }),
    };
    const room = await multiSignaling([failing, hub.client()]).join('t');
    await expect(room.send(Uint8Array.of(1))).resolves.toBeUndefined();
    const allBad = await multiSignaling([failing, failing]).join('t');
    await expect(allBad.send(Uint8Array.of(1))).rejects.toThrow('send failed');
  });

  it('leaves late-joining networks after leave()', async () => {
    let release: () => void = () => {};
    let leftLate = false;
    const slow: Signaling = {
      id: 'slow',
      join: () =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              send: async () => {},
              onMessage: () => () => {},
              leave: async () => {
                leftLate = true;
              },
            });
        }),
    };
    const room = await multiSignaling([new MemorySignalingHub().client(), slow]).join('t');
    await room.leave();
    release();
    await new Promise((r) => setTimeout(r, 0));
    expect(leftLate).toBe(true);
  });
});
