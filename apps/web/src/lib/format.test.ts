import { describe, expect, it } from 'vitest';
import { formatBytes } from './format.ts';

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
