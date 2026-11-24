import { describe, expect, it } from 'vitest';
import {
  bytesSource,
  dataChannelAdapter,
  generateSecret,
  type LinkOptions,
  type LinkPhase,
  LinkReceiver,
  LinkSender,
  type Signaling,
} from '../src/index.ts';
import { FakeDataChannel, FakePeer, type FakeRtcOptions, fakeRtc } from '../src/testing/index.ts';
import { codeOf, memoryRoom, patternBytes } from './helpers.ts';
import { MemorySink } from './memory-sink.ts';

type Hub = ReturnType<typeof memoryRoom>;

function signalingFor(hub: Hub): Signaling {
  return { id: 'memory', join: async () => hub.join() };
}

interface World {
  hub?: Hub;
  rtc?: FakeRtcOptions;
  timeouts?: LinkOptions['timeouts'];
}

function world(w: World = {}) {
  const hub = w.hub ?? memoryRoom();
  const rtc = fakeRtc(w.rtc);
  const secret = generateSecret();
  const base: LinkOptions = {
    secret,
    signaling: signalingFor(hub),
    rtc,
    iceServers: [{ urls: 'stun:stun.example.org' }],
    timeouts: { peerTimeoutMs: 2_000, connectTimeoutMs: 2_000, joinIntervalMs: 20, ...w.timeouts },
    config: { closeGraceMs: 200 },
  };
  return { hub, rtc, base };
}

function phases(s: { on(e: 'phase', cb: (p: LinkPhase) => void): unknown }) {
  const out: LinkPhase[] = [];
  s.on('phase', (p) => out.push(p));
  return out;
}

const file = (size = 300_000) => bytesSource(patternBytes(size, 7), 'dir/data.bin');

describe('LinkSender / LinkReceiver over WebRTC (fake)', () => {
  it('transfers a file end to end and leaves the signaling room', async () => {
    const { hub, rtc, base } = world();
    const src = patternBytes(300_000, 7);
    const sink = new MemorySink();
    const sender = new LinkSender({ ...base, files: [bytesSource(src, 'dir/data.bin')] });
    const receiver = new LinkReceiver({ ...base, onManifest: () => ({ sink }) });
    const sp = phases(sender);
    const rp = phases(receiver);

    const sending = sender.start();
    const outcome = await receiver.start();
    await sending;

    expect(outcome).toBe('completed');
    const blob = sink.files.get('dir/data.bin');
    expect(blob && new Uint8Array(await blob.arrayBuffer())).toEqual(src);
    expect(sp).toEqual([
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
    expect(rp).toEqual([
      'joining',
      'waiting',
      'connecting',
      'handshaking',
      'connected',
      'reviewing',
      'transferring',
      'finishing',
      'done',
    ]);
    expect(rtc.peers[0]?.config.iceServers).toEqual(base.iceServers);
    await new Promise((r) => setTimeout(r, 0));
    expect(hub.left).toBe(2);
  });

  it('lets the sender decline an unexpected receiver', async () => {
    const { base } = world();
    const sender = new LinkSender({ ...base, files: [file()], confirmPeer: async () => false });
    const receiver = new LinkReceiver({ ...base, onManifest: () => null });
    const [s, r] = await Promise.allSettled([sender.start(), receiver.start()]);
    expect(codeOf(s)).toBe('DECLINED');
    expect(codeOf(r)).toBe('DECLINED');
  });

  it('recovers when the offer is lost on the relays', async () => {
    // log[0] = receiver's first join, log[1] = sender's first offer
    const { base } = world({ hub: memoryRoom({ drop: (_, i) => i === 1 }) });
    const sink = new MemorySink();
    const sender = new LinkSender({ ...base, files: [file(10)] });
    const sending = sender.start();
    await new Promise((r) => setTimeout(r, 5));
    const receiver = new LinkReceiver({ ...base, onManifest: () => ({ sink }) });
    await expect(receiver.start()).resolves.toBe('completed');
    await sending;
  });

  it('ignores a second receiver on the same link', async () => {
    const { base } = world();
    const sink = new MemorySink();
    const sender = new LinkSender({ ...base, files: [file(10)] });
    const sending = sender.start();
    const first = new LinkReceiver({ ...base, onManifest: () => ({ sink }) });
    const firstDone = first.start();
    await new Promise((r) => setTimeout(r, 5));
    const second = new LinkReceiver({
      ...base,
      timeouts: { ...base.timeouts, peerTimeoutMs: 150 },
      onManifest: () => ({ sink: new MemorySink() }),
    });
    const [a, b] = await Promise.allSettled([firstDone, second.start()]);
    await sending;
    expect(codeOf(a)).toBe('OK');
    expect(codeOf(b)).toBe('PEER_TIMEOUT');
  });

  it('reports PEER_TIMEOUT when nobody answers', async () => {
    const { base } = world({ timeouts: { peerTimeoutMs: 60 } });
    const receiver = new LinkReceiver({ ...base, onManifest: () => null });
    const p = phases(receiver);
    await expect(receiver.start()).rejects.toMatchObject({ code: 'PEER_TIMEOUT' });
    expect(p.at(-1)).toBe('failed');
  });

  it('reports ICE_FAILED on both sides when the networks block each other', async () => {
    const { base } = world({ rtc: { failIce: true } });
    const sender = new LinkSender({ ...base, files: [file()] });
    const receiver = new LinkReceiver({ ...base, onManifest: () => null });
    const [s, r] = await Promise.allSettled([sender.start(), receiver.start()]);
    expect([codeOf(s), codeOf(r)]).toEqual(['ICE_FAILED', 'ICE_FAILED']);
  });

  it('reports ICE_FAILED when connecting takes too long', async () => {
    const { base } = world({ rtc: { hang: true }, timeouts: { connectTimeoutMs: 80 } });
    const sender = new LinkSender({ ...base, files: [file()] });
    const receiver = new LinkReceiver({ ...base, onManifest: () => null });
    const [s, r] = await Promise.allSettled([sender.start(), receiver.start()]);
    expect([codeOf(s), codeOf(r)]).toEqual(['ICE_FAILED', 'ICE_FAILED']);
  });

  it('cancels while waiting for the receiver', async () => {
    const { base } = world();
    const sender = new LinkSender({ ...base, files: [file()] });
    const p = phases(sender);
    sender.on('phase', (ph) => ph === 'waiting' && sender.cancel());
    await expect(sender.start()).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(p).toEqual(['joining', 'waiting', 'cancelled']);
  });

  it('tells the receiver when the sender cancels mid-connection', async () => {
    const { base } = world({ rtc: { hang: true }, timeouts: { connectTimeoutMs: 5_000 } });
    const sender = new LinkSender({ ...base, files: [file()] });
    const receiver = new LinkReceiver({ ...base, onManifest: () => null });
    receiver.on('phase', (ph) => ph === 'connecting' && setTimeout(() => sender.cancel(), 10));
    const [s, r] = await Promise.allSettled([sender.start(), receiver.start()]);
    expect([codeOf(s), codeOf(r)]).toEqual(['CANCELLED', 'CANCELLED']);
  });

  it('cancels during the transfer through the engine', async () => {
    const { base } = world();
    const sink = new MemorySink();
    const sender = new LinkSender({ ...base, files: [file(3_000_000)] });
    const receiver = new LinkReceiver({ ...base, onManifest: () => ({ sink }) });
    let once = false;
    receiver.on('progress', () => {
      if (!once) {
        once = true;
        receiver.cancel();
      }
    });
    const [s, r] = await Promise.allSettled([sender.start(), receiver.start()]);
    expect([codeOf(s), codeOf(r)]).toEqual(['CANCELLED', 'CANCELLED']);
    expect(sink.files.size).toBe(0);
  });

  it('maps a failing signaling network to SIGNALING_UNREACHABLE', async () => {
    const { base } = world();
    const signaling: Signaling = {
      id: 'broken',
      join: () => Promise.reject(new Error('all relays down')),
    };
    const receiver = new LinkReceiver({ ...base, signaling, onManifest: () => null });
    await expect(receiver.start()).rejects.toMatchObject({ code: 'SIGNALING_UNREACHABLE' });
  });

  it('rejects an empty file list up front', () => {
    const { base } = world();
    expect(() => new LinkSender({ ...base, files: [] })).toThrow(RangeError);
  });
});

describe('dataChannelAdapter', () => {
  it('converts messages, tracks closing and refuses sends afterwards', async () => {
    const dc = new FakeDataChannel('x');
    const remote = new FakeDataChannel('x');
    dc.peer = remote;
    remote.peer = dc;
    dc.open();
    remote.open();
    const ch = dataChannelAdapter(remote);
    expect(remote.binaryType).toBe('arraybuffer');
    const got: Uint8Array[] = [];
    ch.onMessage((m) => got.push(m));
    dc.send(Uint8Array.of(1, 2));
    remote.dispatchEvent(new MessageEvent('message', { data: 'a string' }));
    await new Promise((r) => setTimeout(r, 5));
    expect(got).toEqual([new Uint8Array(0), Uint8Array.of(1, 2)]); // the string was dispatched synchronously

    ch.bufferedAmountLowThreshold = 123;
    expect(remote.bufferedAmountLowThreshold).toBe(123);
    let lows = 0;
    const off = ch.onBufferedAmountLow(() => lows++);
    remote.dispatchEvent(new Event('bufferedamountlow'));
    off();
    remote.dispatchEvent(new Event('bufferedamountlow'));
    expect(lows).toBe(1);
    expect(ch.bufferedAmount).toBe(0);

    let closes = 0;
    ch.onClose(() => closes++);
    dc.close();
    await new Promise((r) => setTimeout(r, 5));
    expect(ch.closed).toBe(true);
    expect(closes).toBe(1);
    expect(() => ch.send(Uint8Array.of(1))).toThrow(/closed/);
    let late = 0;
    ch.onClose(() => late++);
    await Promise.resolve();
    expect(late).toBe(1);
  });

  it('treats a failed peer connection as closed and closes both on close()', async () => {
    const pc = new FakePeer({}, {});
    const dc = new FakeDataChannel('x');
    dc.open();
    const ch = dataChannelAdapter(dc, pc);
    let closed = false;
    ch.onClose(() => {
      closed = true;
    });
    pc.connectionState = 'failed';
    pc.dispatchEvent(new Event('connectionstatechange'));
    expect(closed).toBe(true);

    const pc2 = new FakePeer({}, {});
    const dc2 = new FakeDataChannel('y');
    dc2.open();
    const ch2 = dataChannelAdapter(dc2, pc2);
    ch2.close();
    expect(ch2.closed).toBe(true);
    expect(dc2.readyState).toBe('closed');
    expect(pc2.connectionState).toBe('closed');
  });
});
