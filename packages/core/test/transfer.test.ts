import { describe, expect, it } from 'vitest';
import { type Bytes, concat, equalBytes } from '../src/bytes.ts';
import { DEFAULT_CONFIG, resolveConfig } from '../src/config.ts';
import { ErrorCode, TransferError } from '../src/errors.ts';
import {
  bytesSource,
  createLoopbackPair,
  deriveLinkKeys,
  type FileSink,
  generateSecret,
  Receiver,
} from '../src/index.ts';
import { encodeChunk, encodeJson, FrameType } from '../src/protocol/frames.ts';
import { SecureChannel } from '../src/session/secure-channel.ts';
import { codeOf, patternBytes, run, setup } from './helpers.ts';

const MiB = 1024 * 1024;

/** Test sink that collects bytes and can be slowed down or made to fail. */
function testSink(opts: { delayMs?: number; failAt?: number; error?: Error } = {}) {
  const files = new Map<string, Uint8Array>();
  const aborted: string[] = [];
  let totalWritten = 0;
  const sink: FileSink = {
    id: 'test',
    async open(meta) {
      const parts: Uint8Array[] = [];
      return {
        async write(chunk) {
          if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
          if (opts.failAt !== undefined && totalWritten + chunk.byteLength > opts.failAt) {
            throw opts.error ?? new Error('disk on fire');
          }
          parts.push(chunk.slice());
          totalWritten += chunk.byteLength;
        },
        async close() {
          files.set(meta.path, concat(...parts));
        },
        async abort() {
          aborted.push(meta.path);
        },
      };
    },
  };
  return { sink, files, aborted };
}

describe('transfer over loopback', () => {
  it('delivers 0 B, 1 B and 50 MiB files intact with bounded buffering', async () => {
    const big = patternBytes(50 * MiB, 7);
    const files = [
      bytesSource(new Uint8Array(0), 'empty'),
      bytesSource(Uint8Array.of(42), 'one'),
      bytesSource(big, 'dir/big.bin'),
    ];
    const { sink, files: got } = testSink();
    const { a, sender, receiver, manifests } = await setup({ files, sink });

    const phases: string[] = [];
    sender.on('phase', (p) => phases.push(p));
    let lastProgress = { sent: 0, acked: 0, total: 0 };
    sender.on('progress', (p) => {
      lastProgress = p;
    });

    const result = await run(sender, receiver);
    expect(codeOf(result.sender)).toBe('OK');
    expect(result.receiver).toEqual({ status: 'fulfilled', value: 'completed' });

    expect(manifests[0]?.files.map((f) => f.path)).toEqual(['empty', 'one', 'dir/big.bin']);
    expect(got.get('empty')?.byteLength).toBe(0);
    expect(got.get('one')).toEqual(Uint8Array.of(42));
    expect(equalBytes(got.get('dir/big.bin') ?? new Uint8Array(), big)).toBe(true);

    const total = 50 * MiB + 1;
    expect(lastProgress).toEqual({ sent: total, acked: total, total });
    expect(phases).toEqual([
      'handshaking',
      'connected',
      'awaiting-accept',
      'transferring',
      'finishing',
      'done',
    ]);
    // backpressure: never more than the high watermark plus one frame in flight
    expect(a.stats.maxBufferedAmount).toBeLessThanOrEqual(
      DEFAULT_CONFIG.bufferedAmountHigh + DEFAULT_CONFIG.maxFrameSize,
    );
    expect(a.closed).toBe(true);
  }, 60_000);

  it('sends only the files the receiver accepts, in its order', async () => {
    const files = ['a', 'b', 'c'].map((p, i) => bytesSource(patternBytes(1000, i + 1), p));
    const { sink, files: got } = testSink();
    const { sender, receiver } = await setup({ files, decide: () => ({ sink, files: [2, 0] }) });
    const result = await run(sender, receiver);
    expect(codeOf(result.sender)).toBe('OK');
    expect([...got.keys()]).toEqual(['c', 'a']);
  });

  it('reports a decline to the sender', async () => {
    const { sender, receiver } = await setup({
      files: [bytesSource(Uint8Array.of(1), 'x')],
      decide: () => null,
    });
    const senderPhases: string[] = [];
    sender.on('phase', (p) => senderPhases.push(p));
    const result = await run(sender, receiver);
    expect(result.receiver).toEqual({ status: 'fulfilled', value: 'declined' });
    expect(codeOf(result.sender)).toBe('DECLINED');
    expect(senderPhases.at(-1)).toBe('declined');
  });

  it('respects the flow-control window with a slow sink', async () => {
    const config = { maxUnackedBytes: 2 * MiB };
    const { sink } = testSink({ delayMs: 1 });
    const { sender, receiver } = await setup({
      files: [bytesSource(patternBytes(6 * MiB), 'slow')],
      sink,
      config,
    });
    let maxInFlight = 0;
    sender.on('progress', (p) => {
      maxInFlight = Math.max(maxInFlight, p.sent - p.acked);
    });
    const result = await run(sender, receiver);
    expect(codeOf(result.sender)).toBe('OK');
    expect(maxInFlight).toBeLessThanOrEqual(config.maxUnackedBytes + DEFAULT_CONFIG.chunkSize);
  }, 30_000);

  it.each(['sender', 'receiver'] as const)(
    'cancel from the %s stops both sides',
    async (who) => {
      const { sink, aborted } = testSink({ delayMs: 1 });
      const { sender, receiver } = await setup({ files: [bytesSource(patternBytes(8 * MiB), 'big')], sink });
      receiver.on('progress', (p) => {
        if (p.received > MiB) (who === 'sender' ? sender : receiver).cancel();
      });
      const result = await run(sender, receiver);
      expect(codeOf(result.sender)).toBe('CANCELLED');
      expect(codeOf(result.receiver)).toBe('CANCELLED');
      expect(aborted).toEqual(['big']);
    },
    30_000,
  );

  it('maps a full disk to STORAGE_QUOTA and tells the sender', async () => {
    const quota = new DOMException('full', 'QuotaExceededError');
    const { sink, aborted } = testSink({ failAt: 100_000, error: quota });
    const { sender, receiver } = await setup({ files: [bytesSource(patternBytes(MiB), 'f')], sink });
    const result = await run(sender, receiver);
    expect(codeOf(result.receiver)).toBe('STORAGE_QUOTA');
    expect(codeOf(result.sender)).toBe('STORAGE_QUOTA');
    expect(aborted).toEqual(['f']);
  });
});

describe('transfer security', () => {
  const files = () => [bytesSource(patternBytes(300_000), 'f')];
  // a→b message indices: 0 HELLO, 1 MANIFEST, 2.. CHUNKs
  const firstChunk = 2;

  type Mutate = (m: Bytes, i: number) => Bytes[];
  it.each<[string, Mutate]>([
    ['tampered', (m, i) => (i === firstChunk ? [flip(m, 40)] : [m])],
    ['dropped', (m, i) => (i === firstChunk ? [] : [m])],
    ['duplicated', (m, i) => (i === firstChunk ? [m, m] : [m])],
    ['reordered', reorder(firstChunk)],
  ])('aborts both sides on a %s frame', async (_, mutate) => {
    const { sink, files: got } = testSink();
    const { sender, receiver } = await setup({
      files: files(),
      sink,
      loopback: { intercept: (m, i, dir) => (dir === 'a→b' ? mutate(m, i) : [m]) },
    });
    const result = await run(sender, receiver);
    expect(codeOf(result.receiver)).toBe('PROTOCOL_ERROR');
    expect(codeOf(result.sender)).toBe('PROTOCOL_ERROR');
    expect(got.size).toBe(0);
  });

  it('fails when the receiver has a different secret', async () => {
    const decide = () => {
      throw new Error('must not reach review');
    };
    const { sender, receiver } = await setup({ files: files(), decide, mismatchedSecret: true });
    const result = await run(sender, receiver);
    expect(codeOf(result.receiver)).toBe('PROTOCOL_ERROR');
    expect(codeOf(result.sender)).toBe('PROTOCOL_ERROR');
  });

  it('detects a protocol version mismatch', async () => {
    const { sink } = testSink();
    const { sender, receiver } = await setup({
      files: files(),
      sink,
      loopback: { intercept: (m, i, dir) => (dir === 'a→b' && i === 0 ? [setByte(m, 4, 2)] : [m]) },
    });
    const result = await run(sender, receiver);
    expect(codeOf(result.receiver)).toBe('VERSION_MISMATCH');
    expect(result.sender.status).toBe('rejected');
  });

  it('rejects a malicious manifest before the user sees it', async () => {
    const [a, b] = createLoopbackPair();
    const { sessionIkm } = await deriveLinkKeys(generateSecret());
    let reviewed = false;
    const receiver = new Receiver(b, {
      sessionIkm,
      onManifest: () => {
        reviewed = true;
        return null;
      },
    });
    const evil = new SecureChannel(a, 'sender', resolveConfig());
    const receiving = receiver.start();
    await evil.handshake(sessionIkm);
    await evil.send(
      FrameType.Manifest,
      encodeJson({ files: [{ path: '../../.bashrc', size: 1, mime: '' }], chunkSize: 1024, total: 1 }),
    );
    await expect(receiving).rejects.toThrow(/unsafe path/);
    expect(reviewed).toBe(false);
    // the receiver reports the problem back instead of just hanging up
    await expect(evil.next()).rejects.toMatchObject({ code: 'PROTOCOL_ERROR', fromPeer: true });
  });

  it('rejects data beyond the declared size from a malicious sender', async () => {
    const [a, b] = createLoopbackPair();
    const { sessionIkm } = await deriveLinkKeys(generateSecret());
    const { sink, files: got } = testSink();
    const receiver = new Receiver(b, { sessionIkm, onManifest: () => ({ sink }) });
    const evil = new SecureChannel(a, 'sender', resolveConfig());
    const receiving = receiver.start();
    await evil.handshake(sessionIkm);
    await evil.send(
      FrameType.Manifest,
      encodeJson({ files: [{ path: 'f', size: 2, mime: '' }], chunkSize: 1024, total: 2 }),
    );
    await evil.next(); // ACCEPT
    await evil.send(FrameType.Chunk, encodeChunk(0, 0, new Uint8Array(3)));
    await expect(receiving).rejects.toThrow(/beyond declared file size/);
    expect(got.size).toBe(0);
  });
});

function flip(m: Uint8Array, index: number): Uint8Array<ArrayBuffer> {
  const copy = m.slice();
  copy[index] = (copy[index] ?? 0) ^ 0xff;
  return copy;
}

function setByte(m: Uint8Array, index: number, value: number): Uint8Array<ArrayBuffer> {
  const copy = m.slice();
  copy[index] = value;
  return copy;
}

/** Swap message `at` with the one after it. */
function reorder(at: number) {
  let held: Uint8Array<ArrayBuffer> | undefined;
  return (m: Uint8Array<ArrayBuffer>, i: number) => {
    if (i === at) {
      held = m;
      return [];
    }
    if (i === at + 1 && held) return [m, held];
    return [m];
  };
}

describe('abort', () => {
  it('a second abort does not cut short the first one’s goodbye', async () => {
    const [a, b] = createLoopbackPair();
    const { sessionIkm } = await deriveLinkKeys(generateSecret());
    const cfg = resolveConfig();
    const left = new SecureChannel(a, 'sender', cfg);
    const right = new SecureChannel(b, 'receiver', cfg);
    await Promise.all([left.handshake(sessionIkm), right.handshake(sessionIkm)]);
    const reading = right.next();
    await left.abort(new TransferError(ErrorCode.Declined, 'no'));
    await left.abort(new TransferError(ErrorCode.Cancelled));
    await expect(reading).rejects.toMatchObject({ code: 'DECLINED', fromPeer: true });
  });
});
