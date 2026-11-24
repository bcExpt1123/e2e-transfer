import { describe, expect, it } from 'vitest';
import { utf8 } from '../src/bytes.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { FrameCipher } from '../src/protocol/cipher.ts';
import {
  decodeChunk,
  decodeHello,
  decodePosition,
  encodeChunk,
  encodeHello,
  encodePosition,
  FrameType,
} from '../src/protocol/frames.ts';
import { pathProblem, validateAccept, validateManifest } from '../src/protocol/manifest.ts';

const aesKey = () =>
  crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]) as Promise<CryptoKey>;

async function pair() {
  const key = await aesKey();
  return { tx: new FrameCipher(key, 65536), rx: new FrameCipher(key, 65536) };
}

describe('codecs', () => {
  it('round-trips HELLO', () => {
    const nonce = crypto.getRandomValues(new Uint8Array(16));
    expect(decodeHello(encodeHello({ version: 1, role: 'receiver', nonce }))).toEqual({
      version: 1,
      role: 'receiver',
      nonce,
    });
    expect(() => decodeHello(utf8('nope'))).toThrow(expect.objectContaining({ code: 'PROTOCOL_ERROR' }));
  });

  it('round-trips CHUNK and positions with large offsets', () => {
    const data = Uint8Array.of(1, 2, 3);
    const big = 2 ** 40 + 7;
    expect(decodeChunk(encodeChunk(9, big, data))).toEqual({ fileIdx: 9, offset: big, data });
    expect(decodePosition(encodePosition(3, big))).toEqual({ fileIdx: 3, value: big });
  });
});

describe('FrameCipher', () => {
  it('round-trips frames in order', async () => {
    const { tx, rx } = await pair();
    for (let i = 0; i < 3; i++) {
      const frame = await tx.seal(FrameType.Ack, Uint8Array.of(i));
      expect(await rx.open(frame)).toEqual({ type: FrameType.Ack, payload: Uint8Array.of(i) });
    }
  });

  it('rejects a skipped (dropped) frame', async () => {
    const { tx, rx } = await pair();
    await tx.seal(FrameType.Ack, Uint8Array.of(0));
    const second = await tx.seal(FrameType.Ack, Uint8Array.of(1));
    await expect(rx.open(second)).rejects.toThrow(/counter 1, expected 0/);
  });

  it('rejects a replayed frame', async () => {
    const { tx, rx } = await pair();
    const f = await tx.seal(FrameType.Ack, Uint8Array.of(0));
    await rx.open(f);
    await expect(rx.open(f)).rejects.toThrow(/counter 0, expected 1/);
  });

  it('rejects tampered ciphertext and tampered header (AAD)', async () => {
    for (const index of [20, 1]) {
      const { tx, rx } = await pair();
      const f = await tx.seal(FrameType.Ack, new Uint8Array(16));
      f[index] = (f[index] ?? 0) ^ 1;
      await expect(rx.open(f)).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' });
    }
  });

  it('rejects a frame sealed with another key', async () => {
    const tx = new FrameCipher(await aesKey(), 65536);
    const rx = new FrameCipher(await aesKey(), 65536);
    await expect(rx.open(await tx.seal(FrameType.Done, new Uint8Array(0)))).rejects.toThrow(/authentication/);
  });

  it('rejects truncated and oversized frames', async () => {
    const { rx } = await pair();
    await expect(rx.open(new Uint8Array(27))).rejects.toThrow(/too short/);
    await expect(rx.open(new Uint8Array(65537))).rejects.toThrow(/maxFrameSize/);
  });
});

describe('path safety', () => {
  it.each(['a.txt', 'photos/2024/IMG 1.jpg', 'ünïcødé/文件.txt', '.hidden', 'a..b'])('accepts %j', (p) => {
    expect(pathProblem(p)).toBeNull();
  });

  it.each([
    '',
    '/etc/passwd',
    '../escape',
    'a/../../b',
    'a/./b',
    'a//b',
    'dir/',
    'C:\\Windows',
    'c:/x',
    'a\\b',
    'nul\u0000byte',
    'line\nbreak',
    'evil\u202Etxt.exe',
    'x'.repeat(256),
  ])('rejects %j', (p) => {
    expect(pathProblem(p)).not.toBeNull();
  });
});

describe('manifest validation', () => {
  const valid = {
    files: [
      { path: 'a', size: 1, mime: 'text/plain' },
      { path: 'b/c', size: 0, mime: '' },
    ],
    chunkSize: DEFAULT_CONFIG.chunkSize,
    total: 1,
  };

  it('accepts a valid manifest and strips unknown fields', () => {
    const m = validateManifest(
      { ...valid, extra: 1, files: [{ ...valid.files[0], evil: true }], total: 1 },
      DEFAULT_CONFIG,
    );
    expect(m.files[0]).toEqual({ path: 'a', size: 1, mime: 'text/plain' });
  });

  it.each([
    ['not an object', 42],
    ['no files', { ...valid, files: [], total: 0 }],
    ['wrong total', { ...valid, total: 99 }],
    ['negative size', { ...valid, files: [{ path: 'a', size: -1, mime: '' }], total: -1 }],
    ['fractional size', { ...valid, files: [{ path: 'a', size: 1.5, mime: '' }], total: 1.5 }],
    ['duplicate path', { ...valid, files: [valid.files[0], valid.files[0]], total: 2 }],
    ['unsafe path', { ...valid, files: [{ path: '../x', size: 1, mime: '' }] }],
    ['huge chunkSize', { ...valid, chunkSize: 10 ** 9 }],
    ['zero chunkSize', { ...valid, chunkSize: 0 }],
    ['control char in mime', { ...valid, files: [{ path: 'a', size: 1, mime: 'x\ny' }] }],
  ])('rejects %s', (_, value) => {
    expect(() => validateManifest(value, DEFAULT_CONFIG)).toThrow(
      expect.objectContaining({ code: 'PROTOCOL_ERROR' }),
    );
  });

  it('enforces maxFiles', () => {
    const files = Array.from({ length: 3 }, (_, i) => ({ path: `f${i}`, size: 0, mime: '' }));
    expect(() =>
      validateManifest({ files, chunkSize: 1024, total: 0 }, { ...DEFAULT_CONFIG, maxFiles: 2 }),
    ).toThrow(/too many/);
  });

  it('validates ACCEPT indices', () => {
    const m = validateManifest(valid, DEFAULT_CONFIG);
    expect(validateAccept({ files: [1, 0], extra: 1 }, m)).toEqual({ files: [1, 0] });
    for (const files of [[2], [-1], [0, 0], [0.5], ['0']]) {
      expect(() => validateAccept({ files }, m)).toThrow(/ACCEPT/);
    }
  });

  it('validates resume offsets in ACCEPT', () => {
    const m = validateManifest(valid, DEFAULT_CONFIG);
    const size = m.files[1]?.size ?? 0;
    expect(validateAccept({ files: [1], resume: { 1: size } }, m)).toEqual({
      files: [1],
      resume: { 1: size },
    });
    for (const resume of [[], 'x', { 0: 1 }, { 1: -1 }, { 1: size + 1 }, { 1: 0.5 }, { 7: 0 }]) {
      expect(() => validateAccept({ files: [1], resume }, m)).toThrow(/resume/);
    }
  });
});
