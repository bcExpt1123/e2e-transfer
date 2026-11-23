import { describe, expect, it } from 'vitest';
import { fromHex, toHex } from '../src/bytes.ts';
import { deriveLinkKeys, deriveSessionKeys, hkdf, linkKeyMaterial, sessionKeyMaterial } from '../src/keys.ts';

// Vectors generated independently with node:crypto hkdfSync (see docs/PROTOCOL.md §2).
const SECRET = Uint8Array.from({ length: 32 }, (_, i) => i);
const NONCE_S = Uint8Array.from({ length: 16 }, (_, i) => 0xa0 + i);
const NONCE_R = Uint8Array.from({ length: 16 }, (_, i) => 0xb0 + i);
const VECTORS = {
  room: '61613b59dd18f358e9d3be8b3e846e4d',
  signal: 'c3357b22a3de58bdeb6495605076514bb15fea55ed4b58549d0739cb8c794a43',
  session: '7d115ab434089ce19223619b405041b243e07e30aee0eaf1b5bbb933519d5047',
  s2r: '703ea356586ed2aad961305fd78ab5bba530c3a91e36938600d107ff554b4b08',
  r2s: '5fec86fd48801c298af9b4c39091041b0574c7273f91a86dbdc2d14fe16619a5',
};

describe('hkdf', () => {
  it('matches RFC 5869 test case 1', async () => {
    const okm = await hkdf(
      new Uint8Array(22).fill(0x0b),
      fromHex('000102030405060708090a0b0c'),
      fromHex('f0f1f2f3f4f5f6f7f8f9'),
      42,
    );
    expect(toHex(okm)).toBe(
      '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865',
    );
  });
});

describe('key tree', () => {
  it('derives link material matching the vectors', async () => {
    const m = await linkKeyMaterial(SECRET);
    expect(toHex(m.room)).toBe(VECTORS.room);
    expect(toHex(m.signal)).toBe(VECTORS.signal);
    expect(toHex(m.session)).toBe(VECTORS.session);
  });

  it('derives session material matching the vectors', async () => {
    const ikm = await crypto.subtle.importKey('raw', fromHex(VECTORS.session), 'HKDF', false, ['deriveBits']);
    const m = await sessionKeyMaterial(ikm, NONCE_S, NONCE_R);
    expect(toHex(m.s2r)).toBe(VECTORS.s2r);
    expect(toHex(m.r2s)).toBe(VECTORS.r2s);
  });

  it('exposes the room topic and keeps keys non-extractable', async () => {
    const keys = await deriveLinkKeys(SECRET);
    expect(keys.roomTopic).toBe(VECTORS.room);
    expect(keys.signalKey.extractable).toBe(false);
    expect(keys.sessionIkm.extractable).toBe(false);
    const session = await deriveSessionKeys(keys.sessionIkm, NONCE_S, NONCE_R);
    expect(session.s2r.extractable).toBe(false);
    expect(session.s2r.algorithm.name).toBe('AES-GCM');
  });

  it('rejects wrong secret and nonce lengths', async () => {
    await expect(deriveLinkKeys(new Uint8Array(31))).rejects.toMatchObject({ code: 'LINK_INVALID' });
    const { sessionIkm } = await deriveLinkKeys(SECRET);
    await expect(deriveSessionKeys(sessionIkm, new Uint8Array(15), NONCE_R)).rejects.toMatchObject({
      code: 'PROTOCOL_ERROR',
    });
  });
});
