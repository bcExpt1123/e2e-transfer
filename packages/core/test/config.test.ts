import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, resolveConfig } from '../src/index.ts';

describe('resolveConfig', () => {
  it('returns defaults when no overrides are given', () => {
    expect(resolveConfig()).toEqual(DEFAULT_CONFIG);
  });

  it('applies overrides', () => {
    expect(resolveConfig({ chunkSize: 16 * 1024 }).chunkSize).toBe(16 * 1024);
  });

  it('keeps default chunk frames within the max frame size', () => {
    const { chunkSize, maxFrameSize } = DEFAULT_CONFIG;
    expect(chunkSize + 40).toBeLessThanOrEqual(maxFrameSize);
  });

  it.each([0, -1, 64 * 1024])('rejects chunkSize %i', (chunkSize) => {
    expect(() => resolveConfig({ chunkSize })).toThrow(RangeError);
  });

  it('rejects inverted backpressure thresholds', () => {
    expect(() => resolveConfig({ bufferedAmountLow: 8, bufferedAmountHigh: 4 })).toThrow(RangeError);
  });
});
