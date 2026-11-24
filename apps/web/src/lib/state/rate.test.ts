import { describe, expect, it } from 'vitest';
import { RateMeter } from './rate.ts';

describe('RateMeter', () => {
  it('reports nothing until about a second of data exists', () => {
    const m = new RateMeter();
    expect(m.sample(0, 1000, 0)).toEqual({ bytesPerSecond: 0, secondsLeft: null });
    expect(m.sample(100, 1000, 500)).toEqual({ bytesPerSecond: 0, secondsLeft: null });
  });

  it('converges on a steady rate and estimates time left', () => {
    const m = new RateMeter(1000);
    let s = m.sample(0, 10_000_000, 0);
    for (let t = 100; t <= 5000; t += 100) s = m.sample(t * 1000, 10_000_000, t); // 1 MB/s
    expect(s.bytesPerSecond).toBeCloseTo(1_000_000, -3);
    expect(s.secondsLeft).toBe(5);
  });

  it('smooths a sudden spike', () => {
    const m = new RateMeter(3000);
    m.sample(0, 1e9, 0);
    for (let t = 100; t <= 3000; t += 100) m.sample(t * 1000, 1e9, t);
    const spike = m.sample(3_000_000 + 1_000_000, 1e9, 3100); // 10 MB/s for 100 ms
    expect(spike.bytesPerSecond).toBeLessThan(1_500_000);
  });

  it('ignores repeated timestamps and can be reset', () => {
    const m = new RateMeter();
    m.sample(0, 10, 0);
    m.sample(5, 10, 0);
    m.reset();
    expect(m.sample(0, 10, 50)).toEqual({ bytesPerSecond: 0, secondsLeft: null });
  });
});
