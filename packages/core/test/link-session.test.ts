import { describe, expect, it } from 'vitest';
import {
  bytesSource,
  dataChannelAdapter,
  generateSecret,
  type LinkOptions,
  type LinkPhase,
  LinkReceiver,
  LinkSender,
  SAS_WORDS,
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

const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 2));
  }
};

const bytesOf = async (sink: MemorySink, path: string) => {
  const blob = sink.files.get(path);
  return blob ? new Uint8Array(await blob.arrayBuffer()) : undefined;
};

/** Cut the live connection once the receiver has written `after` bytes (`times` drops in total). */
function severWhen(receiver: LinkReceiver, rtc: ReturnType<typeof fakeRtc>, after: number, times = 1) {
  let cuts = 0;
  receiver.on('progress', (p) => {
    if (cuts < times && p.received >= after * (cuts + 1)) {
      cuts++;
      rtc.peers.at(-1)?.sever();
    }
  });
  return () => cuts;
}

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

  it('shows the same verification words on both sides, plus the receiver’s device hint', async () => {
    const { base } = world();
    const seen: { words: readonly string[]; hint?: string; key?: number }[] = [];
    const sender = new LinkSender({
      ...base,
      files: [file(10)],
      confirmPeer: (peer) => {
        seen.push(peer);
        return false;
      },
    });
    const sending = sender.start();
    const receiver = new LinkReceiver({
      ...base,
      hint: 'Firefox on Android\u202e\n',
      onManifest: () => null,
    });
    let receiverWords: readonly string[] = [];
    receiver.on('words', (w) => {
      receiverWords = w;
    });
    await receiver.start().catch(() => {});
    sender.cancel();
    await sending.catch(() => {});
    expect(seen).toHaveLength(1);
    expect(seen[0]?.words).toHaveLength(4);
    expect(seen[0]?.words).toEqual(receiverWords);
    expect(seen[0]?.hint).toBe('Firefox on Android');
    expect(seen[0]?.key).toBe(1);
    for (const w of receiverWords) expect(SAS_WORDS).toContain(w);
  });

  it('lets the sender decline an unexpected receiver and keeps the link open for the right one', async () => {
    const { base } = world();
    let asked = 0;
    const sink = new MemorySink();
    const sender = new LinkSender({ ...base, files: [file(10)], confirmPeer: async () => ++asked > 1 });
    const sp = phases(sender);
    const sending = sender.start();
    const stranger = new LinkReceiver({ ...base, onManifest: () => null });
    await expect(stranger.start()).rejects.toMatchObject({ code: 'DECLINED' });
    await until(() => sp.at(-1) === 'waiting');
    const friend = new LinkReceiver({ ...base, onManifest: () => ({ sink }) });
    await expect(friend.start()).resolves.toBe('completed');
    await sending;
    expect(sp.filter((p) => p === 'waiting')).toHaveLength(2);
    expect(sender.receivers.map((r) => r.phase)).toEqual(['declined', 'done']);
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

  it('tells a second receiver that the sender is busy', async () => {
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
    expect(codeOf(b)).toBe('LINK_BUSY');
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

describe('resume after a lost connection', () => {
  it('reconnects and continues from the written offset, byte-identical', async () => {
    const { rtc, base } = world();
    const a = patternBytes(1_500_000, 3);
    const b = patternBytes(2_000_000, 4);
    const sink = new MemorySink();
    const sender = new LinkSender({ ...base, files: [bytesSource(a, 'a.bin'), bytesSource(b, 'b.bin')] });
    const receiver = new LinkReceiver({ ...base, onManifest: () => ({ sink }) });
    const sp = phases(sender);
    const rp = phases(receiver);
    const cuts = severWhen(receiver, rtc, 1_200_000, 2); // once in a.bin, once in b.bin
    const sentTotals: number[] = [];
    sender.on('progress', (p) => sentTotals.push(p.acked));

    const sending = sender.start();
    await expect(receiver.start()).resolves.toBe('completed');
    await sending;

    expect(cuts()).toBe(2);
    expect(await bytesOf(sink, 'a.bin')).toEqual(a);
    expect(await bytesOf(sink, 'b.bin')).toEqual(b);
    expect(rp.filter((p) => p === 'reconnecting')).toHaveLength(2);
    expect(sp.filter((p) => p === 'reconnecting')).toHaveLength(2);
    // Never asked again and never started over: one review, progress never went backwards past zero.
    expect(rp.filter((p) => p === 'reviewing')).toHaveLength(1);
    expect(sp.at(-1)).toBe('done');
    expect(sentTotals.at(-1)).toBe(a.byteLength + b.byteLength);
    expect(rtc.peers.length).toBe(6);
  });

  it('does not let another device with the link take over a reconnecting transfer', async () => {
    const { rtc, base } = world({ timeouts: { resumeTimeoutMs: 400 } });
    const sink = new MemorySink();
    const sender = new LinkSender({ ...base, files: [file(3_000_000)] });
    const receiver = new LinkReceiver({ ...base, onManifest: () => ({ sink }) });
    let stranger: Promise<unknown> | undefined;
    receiver.on('progress', (p) => {
      if (stranger || p.received < 500_000) return;
      receiver.cancel(); // the receiver is gone for good…
      rtc.peers.at(-1)?.sever();
      // …and someone else who has the link shows up.
      stranger = new LinkReceiver({ ...base, onManifest: () => ({ sink: new MemorySink() }) }).start();
      stranger.catch(() => {});
    });
    const [s, r] = await Promise.allSettled([sender.start(), receiver.start()]);
    expect(codeOf(r)).toBe('CANCELLED');
    expect(codeOf(s)).toBe('CONNECTION_LOST'); // gave up after resumeTimeoutMs
    expect(codeOf((await Promise.allSettled([stranger]))[0] as PromiseSettledResult<unknown>)).toBe(
      'LINK_BUSY',
    );
  });

  it('gives up on the receiver side when the sender never comes back', async () => {
    const { rtc, base } = world({ timeouts: { resumeTimeoutMs: 300 } });
    const sink = new MemorySink();
    const sender = new LinkSender({ ...base, files: [file(3_000_000)] });
    const receiver = new LinkReceiver({ ...base, onManifest: () => ({ sink }) });
    receiver.on('progress', (p) => {
      if (p.received < 500_000 || sink.aborted > 0) return;
      sender.cancel();
      rtc.peers.at(-1)?.sever();
    });
    const rp = phases(receiver);
    const [s, r] = await Promise.allSettled([sender.start(), receiver.start()]);
    expect(codeOf(s)).toBe('CANCELLED');
    expect(codeOf(r)).toBe('CONNECTION_LOST');
    expect(rp.slice(-2)).toEqual(['reconnecting', 'failed']);
    expect(sink.files.size).toBe(0);
    expect(sink.aborted).toBe(1); // the partial file was discarded
  });
});

describe('several receivers on one link', () => {
  it('sends to each receiver separately, up to the cap', async () => {
    const { base } = world();
    const src = patternBytes(800_000, 9);
    const approved: number[] = [];
    const sender = new LinkSender({
      ...base,
      files: [bytesSource(src, 'x.bin')],
      maxReceivers: 2,
      confirmPeer: (peer) => {
        approved.push(peer.key ?? 0);
        return true;
      },
    });
    const sp = phases(sender);
    const sending = sender.start();
    const sinks = [new MemorySink(), new MemorySink()];
    const receivers = sinks.map((sink) => new LinkReceiver({ ...base, onManifest: () => ({ sink }) }));
    const both = Promise.all(receivers.map((r) => r.start()));
    await until(
      () => sender.receivers.length === 2 && sender.receivers.every((r) => r.phase === 'transferring'),
    );
    const third = new LinkReceiver({ ...base, onManifest: () => null });
    await expect(third.start()).rejects.toMatchObject({ code: 'LINK_BUSY' });

    await expect(both).resolves.toEqual(['completed', 'completed']);
    await until(() => sender.receivers.every((r) => r.phase === 'done'));
    for (const sink of sinks) expect(await bytesOf(sink, 'x.bin')).toEqual(src);
    expect(approved.sort()).toEqual([1, 2]);
    expect(sender.receivers.map((r) => r.progress.acked)).toEqual([src.byteLength, src.byteLength]);
    expect(sp).toEqual(['joining', 'waiting']); // the share stays open…

    const late = new MemorySink(); // …so a slot freed up for someone else
    await expect(new LinkReceiver({ ...base, onManifest: () => ({ sink: late }) }).start()).resolves.toBe(
      'completed',
    );
    sender.cancel();
    await expect(sending).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(sp.at(-1)).toBe('cancelled');
  });

  it('cancels one receiver without affecting the others', async () => {
    const { base } = world();
    const sender = new LinkSender({ ...base, files: [file(3_000_000)], maxReceivers: 3 });
    const sending = sender.start();
    const sinks = [new MemorySink(), new MemorySink()];
    const [first, second] = sinks.map((sink) => new LinkReceiver({ ...base, onManifest: () => ({ sink }) }));
    if (!first || !second) throw new Error('setup');
    const results = Promise.allSettled([first.start(), second.start()]);
    await until(() => sender.receivers.length === 2 && sender.receivers.every((r) => r.progress.acked > 0));
    sender.cancelReceiver(1);
    const [a, b] = await results;
    expect(new Set([codeOf(a), codeOf(b)])).toEqual(new Set(['CANCELLED', 'OK']));
    expect(sender.receivers.map((r) => r.phase).sort()).toEqual(['cancelled', 'done']);
    sender.cancel();
    await sending.catch(() => {});
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
