import { describe, expect, it } from 'vitest';
import { deriveLinkKeys, generateSecret, SAS_WORDS, verificationWords } from '../src/index.ts';

describe('verification words', () => {
  it('uses 256 distinct, short words', () => {
    expect(SAS_WORDS).toHaveLength(256);
    expect(new Set(SAS_WORDS).size).toBe(256);
    for (const w of SAS_WORDS) expect(w).toMatch(/^[a-z]{3,8}$/);
  });

  it('agrees for the same session and differs across sessions', async () => {
    const { sessionIkm } = await deriveLinkKeys(generateSecret());
    const n = (b: number) => new Uint8Array(16).fill(b);
    const a = await verificationWords(sessionIkm, n(1), n(2));
    expect(await verificationWords(sessionIkm, n(1), n(2))).toEqual(a);
    expect(await verificationWords(sessionIkm, n(1), n(3))).not.toEqual(a);
    const other = await deriveLinkKeys(generateSecret());
    expect(await verificationWords(other.sessionIkm, n(1), n(2))).not.toEqual(a);
  });
});
