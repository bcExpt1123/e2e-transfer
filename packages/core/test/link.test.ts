import { describe, expect, it } from 'vitest';
import { fromBase64Url, fromHex, toBase64Url, toHex } from '../src/bytes.ts';
import { encodeLink, generateSecret, isLinkFragment, parseLinkFragment } from '../src/index.ts';

describe('bytes', () => {
  it('round-trips base64url and hex', () => {
    const b = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect(fromBase64Url(toBase64Url(b))).toEqual(b);
    expect(fromHex(toHex(b))).toEqual(b);
    expect(toBase64Url(Uint8Array.of(0xfb, 0xff))).toBe('-_8');
  });

  it('rejects malformed input', () => {
    expect(() => fromBase64Url('ab+c')).toThrow();
    expect(() => fromBase64Url('a')).toThrow();
    expect(() => fromHex('abc')).toThrow();
    expect(() => fromHex('zz')).toThrow();
  });
});

describe('secret links', () => {
  it('encodes and parses a link', () => {
    const secret = generateSecret();
    const link = encodeLink('https://example.test/app/?x=1#old', secret);
    const url = new URL(link);
    expect(url.pathname).toBe('/app/');
    expect(url.search).toBe('?x=1');
    expect(isLinkFragment(url.hash)).toBe(true);
    expect(parseLinkFragment(url.hash)).toEqual(secret);
  });

  it.each([
    ['', 'missing'],
    ['#v2.AAAA', 'wrong version'],
    ['#v1.', 'empty'],
    ['#v1.not*base64', 'bad chars'],
    [`#v1.${toBase64Url(new Uint8Array(16))}`, 'too short'],
  ])('rejects %j (%s)', (hash) => {
    expect(() => parseLinkFragment(hash)).toThrow(expect.objectContaining({ code: 'LINK_INVALID' }));
  });
});
