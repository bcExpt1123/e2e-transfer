import { describe, expect, it, vi } from 'vitest';
import { createLoopbackPair } from '../src/index.ts';

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('LoopbackChannel', () => {
  it('delivers asynchronously and in order', async () => {
    const [a, b] = createLoopbackPair();
    const got: number[] = [];
    b.onMessage((m) => got.push(m[0] ?? -1));
    a.send(Uint8Array.of(1));
    a.send(Uint8Array.of(2));
    expect(got).toEqual([]);
    await tick();
    expect(got).toEqual([1, 2]);
  });

  it('tracks bufferedAmount and fires the low-threshold event', async () => {
    const [a] = createLoopbackPair({ bytesPerTick: 10 });
    a.bufferedAmountLowThreshold = 5;
    const low = vi.fn();
    a.onBufferedAmountLow(low);
    for (let i = 0; i < 3; i++) a.send(new Uint8Array(10));
    expect(a.bufferedAmount).toBe(30);
    await tick();
    expect(a.bufferedAmount).toBe(20);
    await tick();
    await tick();
    expect(a.bufferedAmount).toBe(0);
    expect(low).toHaveBeenCalledOnce();
    expect(a.stats.maxBufferedAmount).toBe(30);
  });

  it('delivers queued messages before closing, then closes both ends', async () => {
    const [a, b] = createLoopbackPair({ bytesPerTick: 1 });
    const got: number[] = [];
    const closed = vi.fn();
    b.onMessage((m) => got.push(m[0] ?? -1));
    b.onClose(closed);
    a.send(Uint8Array.of(7));
    a.send(Uint8Array.of(8));
    a.close();
    expect(() => a.send(Uint8Array.of(9))).toThrow();
    for (let i = 0; i < 5; i++) await tick();
    expect(got).toEqual([7, 8]);
    expect(b.closed).toBe(true);
    expect(closed).toHaveBeenCalledOnce();
  });

  it('lets tests drop, duplicate and modify messages', async () => {
    const [a, b] = createLoopbackPair({
      intercept: (m, i) => (i === 0 ? [] : i === 1 ? [m, m] : [Uint8Array.of(99)]),
    });
    const got: number[] = [];
    b.onMessage((m) => got.push(m[0] ?? -1));
    a.send(Uint8Array.of(1));
    a.send(Uint8Array.of(2));
    a.send(Uint8Array.of(3));
    await tick();
    expect(got).toEqual([2, 2, 99]);
  });
});
