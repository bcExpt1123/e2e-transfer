import { describe, expect, it } from 'vitest';
import { toBase64Url } from '../src/bytes.ts';
import { nameplateKeys } from '../src/code/code.ts';
import {
  CODE_WORDS,
  CodeReceiver,
  CodeSender,
  completeWord,
  formatCode,
  generateCode,
  parseCode,
  resolveWord,
  type ShortCode,
} from '../src/code/index.ts';
import { bytesSource, type Signaling, SignalSession } from '../src/index.ts';
import { fakeRtc } from '../src/testing/index.ts';
import { codeOf, memoryRoom, patternBytes } from './helpers.ts';
import { MemorySink } from './memory-sink.ts';

describe('short codes', () => {
  it('generates N-word-word codes from the BIP-39 list', () => {
    expect(CODE_WORDS).toHaveLength(2048);
    for (let i = 0; i < 50; i++) {
      const c = generateCode();
      expect(c.nameplate).toBeGreaterThanOrEqual(1);
      expect(c.nameplate).toBeLessThanOrEqual(999);
      expect(parseCode(formatCode(c))).toEqual(c);
    }
  });

  it('parses leniently: case, spacing and 4-letter prefixes', () => {
    const want = { nameplate: 7, words: ['abandon', 'ability'] };
    for (const s of [
      '7-abandon-ability',
      ' 7 ABANDON ability ',
      '7-aban-abil',
      '7--abando--abilit',
      '7.abandon,ability',
    ]) {
      expect(parseCode(s)).toEqual(want);
    }
    for (const s of [
      '0-abandon-ability',
      '1000-abandon-ability',
      '7-abandon',
      '7-aba-ability',
      '7-abandon-notaword',
      'x-abandon-ability',
      '7-abandon-ability-zoo',
    ]) {
      expect(parseCode(s)).toBeNull();
    }
  });

  it('resolves and completes words', () => {
    expect(resolveWord('zoo')).toBe('zoo');
    expect(resolveWord('wres')).toBe('wrestle');
    expect(resolveWord('wresx')).toBeNull();
    expect(resolveWord('ab')).toBeNull();
    expect(completeWord('wr')).toEqual(['wrap', 'wreck', 'wrestle', 'wrist', 'write', 'wrong']);
    expect(completeWord('')).toEqual([]);
  });
});

function world() {
  const hub = memoryRoom();
  const signaling: Signaling = { id: 'memory', join: async () => hub.join() };
  return {
    hub,
    signaling,
    base: {
      signaling,
      rtc: fakeRtc(),
      iceServers: [],
      config: { closeGraceMs: 200 },
      timeouts: { peerTimeoutMs: 2_000, connectTimeoutMs: 2_000, joinIntervalMs: 20 },
    },
  };
}

const other = (c: ShortCode): ShortCode => ({
  ...c,
  words: [c.words[0], c.words[1] === 'zoo' ? 'zone' : 'zoo'],
});

describe('code sessions (CPace)', () => {
  it('transfers a file with nothing but the code', async () => {
    const { base } = world();
    const code = generateCode();
    const src = patternBytes(150_000, 9);
    const sender = new CodeSender({ ...base, code, files: [bytesSource(src, 'c.bin')] });
    const phases: string[] = [];
    sender.on('phase', (p) => phases.push(p));
    const sending = sender.start();
    const sink = new MemorySink();
    const receiver = new CodeReceiver({ ...base, code, onManifest: () => ({ sink }) });
    await expect(receiver.start()).resolves.toBe('completed');
    await sending;
    const blob = sink.files.get('c.bin');
    expect(blob && new Uint8Array(await blob.arrayBuffer())).toEqual(src);
    expect(phases).toEqual([
      'joining',
      'waiting',
      'connecting',
      'handshaking',
      'connected',
      'awaiting-accept',
      'transferring',
      'finishing',
      'done',
    ]);
  });

  it('rejects a wrong code, tells the sender, and still lets the right receiver in', async () => {
    const { base } = world();
    const code = generateCode();
    const sender = new CodeSender({ ...base, code, files: [bytesSource(new Uint8Array(10), 'x')] });
    const wrong: number[] = [];
    sender.on('wrongCode', (n) => wrong.push(n));
    const sending = sender.start();

    const guesser = new CodeReceiver({ ...base, code: other(code), onManifest: () => null });
    await expect(guesser.start()).rejects.toMatchObject({ code: 'CODE_INVALID' });
    await new Promise((r) => setTimeout(r, 20));
    expect(wrong).toEqual([1]);

    const sink = new MemorySink();
    const right = new CodeReceiver({ ...base, code, onManifest: () => ({ sink }) });
    await expect(right.start()).resolves.toBe('completed');
    await sending;
  });

  it('gives up after too many wrong codes', async () => {
    const { base } = world();
    const code = generateCode();
    const sender = new CodeSender({
      ...base,
      code,
      maxAttempts: 2,
      files: [bytesSource(new Uint8Array(1), 'x')],
    });
    const sending = sender.start();
    for (let i = 0; i < 2; i++) {
      const g = new CodeReceiver({ ...base, code: other(code), onManifest: () => null });
      await expect(g.start()).rejects.toMatchObject({ code: 'CODE_INVALID' });
    }
    await expect(sending).rejects.toMatchObject({ code: 'CODE_ATTEMPTS' });
  });

  it('counts a malicious identity share as a wrong attempt', async () => {
    const { base, hub } = world();
    const code = generateCode();
    const sender = new CodeSender({
      ...base,
      code,
      maxAttempts: 1,
      files: [bytesSource(new Uint8Array(1), 'x')],
    });
    const sending = sender.start();
    await new Promise((r) => setTimeout(r, 10));
    const { envelopeKey } = await nameplateKeys(code.nameplate);
    const evil = new SignalSession(hub.join(), envelopeKey, { maxSkewMs: 120_000 });
    await evil.send('pake', { Y: toBase64Url(new Uint8Array(32)) });
    await expect(sending).rejects.toMatchObject({ code: 'CODE_ATTEMPTS' });
  });

  it('times out when nobody holds the other end, and can be cancelled', async () => {
    const { base } = world();
    const lonely = new CodeReceiver({
      ...base,
      timeouts: { ...base.timeouts, peerTimeoutMs: 80 },
      code: generateCode(),
      onManifest: () => null,
    });
    await expect(lonely.start()).rejects.toMatchObject({ code: 'PEER_TIMEOUT' });

    const sender = new CodeSender({
      ...base,
      code: generateCode(),
      files: [bytesSource(new Uint8Array(1), 'x')],
    });
    const phases: string[] = [];
    sender.on('phase', (p) => {
      phases.push(p);
      if (p === 'waiting') sender.cancel();
    });
    await expect(sender.start()).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(phases.at(-1)).toBe('cancelled');
    expect(() => new CodeSender({ ...base, code: generateCode(), files: [] })).toThrow(RangeError);
  });

  it('maps an unreachable signaling network', async () => {
    const { base } = world();
    const broken: Signaling = { id: 'x', join: () => Promise.reject(new Error('down')) };
    const r = new CodeReceiver({ ...base, signaling: broken, code: generateCode(), onManifest: () => null });
    const [res] = await Promise.allSettled([r.start()]);
    expect(codeOf(res)).toBe('SIGNALING_UNREACHABLE');
  });
});
