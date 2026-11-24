import { describe, expect, it } from 'vitest';
import { formatBytes, formatDuration, formatRate } from './format.ts';

describe('formatBytes', () => {
  it.each([
    [0, '0 B'],
    [999, '999 B'],
    [1000, '1 KB'],
    [1536, '1.5 KB'],
    [123_456_789, '123 MB'],
    [1.2e9, '1.2 GB'],
    [5e15, '5,000 TB'],
  ])('%d → %s', (bytes, expected) => {
    expect(formatBytes(bytes, 'en-US')).toBe(expected);
  });

  it('handles invalid input', () => {
    expect(formatBytes(-1)).toBe('—');
    expect(formatBytes(Number.NaN)).toBe('—');
  });
});

describe('formatDuration / formatRate', () => {
  it.each([
    [0.2, '1 s'],
    [20, '20 s'],
    [59.4, '59 s'],
    [61, '1 min'],
    [3599, '1 h'],
    [3600, '1 h'],
    [3900, '1 h 5 min'],
    [-1, '—'],
    [Number.NaN, '—'],
  ])('%s s → %s', (s, out) => {
    expect(formatDuration(s)).toBe(out);
  });

  it('formats a rate', () => {
    expect(formatRate(34_000_000, 'en')).toBe('34 MB/s');
  });
});
