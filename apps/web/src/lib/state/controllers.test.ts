import { encodeLink, generateSecret } from '@e2e-transfer/core';
import { fakeRtc } from '@e2e-transfer/core/testing';
import { MemorySignalingHub } from '@e2e-transfer/signaling';
import { MemorySink } from '@e2e-transfer/storage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { incoming } from './link.svelte.ts';
import { ReceiveController, type ReceiveDeps } from './receive.svelte.ts';
import { SendController } from './send.svelte.ts';

const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};

function pair(receiveDeps: Partial<ReceiveDeps> = {}) {
  const hub = new MemorySignalingHub();
  const rtc = fakeRtc();
  const send = new SendController({
    createSignaling: async () => hub.client(),
    rtc,
    baseUrl: () => 'https://app.example/',
  });
  const makeReceiver = () =>
    new ReceiveController({
      createSignaling: async () => hub.client(),
      rtc,
      downloadSink: async () => new MemorySink(),
      canPickFolder: () => false,
      inMemory: () => true,
      ...receiveDeps,
    });
  return { send, makeReceiver, rtc };
}

/** Simulates opening the share link in a new tab. */
function openLink(link: string) {
  location.hash = new URL(link).hash;
  incoming.takeFromLocation();
}

const items = () => [
  { file: new File(['hello world'], 'a.txt', { type: 'text/plain' }), path: 'a.txt' },
  { file: new File([new Uint8Array(70_000)], 'b.bin'), path: 'dir/b.bin' },
];

describe('link intake', () => {
  afterEach(() => incoming.clear());

  it('reads a link once and strips the secret from the address bar', () => {
    openLink(encodeLink('https://x/', generateSecret()));
    expect(incoming.status).toBe('ready');
    expect(incoming.secret?.byteLength).toBe(32);
    expect(location.hash).toBe('');
  });

  it('flags damaged links and ignores unrelated fragments', () => {
    location.hash = '#v1.short';
    incoming.takeFromLocation();
    expect(incoming.status).toBe('invalid');
    incoming.clear();
    location.hash = '#about';
    incoming.takeFromLocation();
    expect(incoming.status).toBe('none');
  });
});

describe('send + receive controllers', () => {
  beforeEach(() => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x');
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    incoming.clear();
  });

  it('runs the full flow: share → approve → review → transfer → done', async () => {
    const { send, makeReceiver } = pair();
    send.share(items());
    expect(send.link).toMatch(/^https:\/\/app\.example\/#v1\./);
    expect(send.busy).toBe(true);
    await until(() => send.phase === 'waiting');

    openLink(send.link ?? '');
    const receive = makeReceiver();
    void receive.start();

    await until(() => send.confirming);
    expect(receive.manifest).toBeNull(); // nothing revealed before the sender approves
    send.approve();

    await until(() => receive.phase === 'reviewing');
    expect(receive.manifest?.files.map((f) => f.path)).toEqual(['a.txt', 'dir/b.bin']);
    expect(receive.busy).toBe(false);
    expect(await receive.accept('download')).toBe(true);

    await until(() => receive.phase === 'done' && send.phase === 'done');
    expect(send.percent).toBe(100);
    expect(receive.percent).toBe(100);
    expect(receive.savedTo?.kind).toBe('download');
    const files = receive.savedTo?.kind === 'download' ? receive.savedTo.files : [];
    expect(files.map((f) => [f.path, f.size])).toEqual([
      ['a.txt', 11],
      ['dir/b.bin', 70_000],
    ]);
    expect(await (await files[0]?.get())?.text()).toBe('hello world');
    await receive.discard();
    expect(receive.savedTo).toBeNull();
  });

  it('keeps the link open after declining an unexpected device', async () => {
    const { send, makeReceiver } = pair();
    send.share(items());
    openLink(send.link ?? '');
    const stranger = makeReceiver();
    void stranger.start();
    await until(() => send.confirming);
    send.decline();
    await until(() => stranger.phase === 'declined');
    expect(stranger.error).toBe('DECLINED');
    await until(() => send.phase === 'waiting');
    expect(send.error).toBeNull();
    send.reset();
    expect(send.link).toBeNull();
    expect(send.phase).toBe('idle');
  });

  it('reports the receiver declining and lets the sender retry with the same link', async () => {
    const { send, makeReceiver } = pair();
    send.share(items());
    const link = send.link;
    openLink(link ?? '');
    const receive = makeReceiver();
    void receive.start();
    await until(() => send.confirming);
    send.approve();
    await until(() => receive.phase === 'reviewing');
    receive.decline();
    await until(() => send.phase === 'declined' && receive.phase === 'declined');
    expect(send.error).toBe('DECLINED');
    expect(receive.error).toBeNull();

    send.retry();
    expect(send.link).toBe(link);
    await until(() => send.phase === 'waiting');
    send.reset();
  });

  it('shows an error when the sender cancels mid-transfer, and recovers on retry', async () => {
    const { send, makeReceiver } = pair();
    send.share([{ file: new File([new Uint8Array(4_000_000)], 'big.bin'), path: 'big.bin' }]);
    openLink(send.link ?? '');
    const receive = makeReceiver();
    void receive.start();
    await until(() => send.confirming);
    send.approve();
    await until(() => receive.phase === 'reviewing');
    await receive.accept('download');
    await until(() => send.phase === 'transferring');
    send.cancel();
    await until(() => receive.phase === 'cancelled' && send.phase === 'cancelled');
    expect([send.error, receive.error]).toEqual(['CANCELLED', 'CANCELLED']);
    expect(send.busy).toBe(false);
  });

  it('treats a dismissed folder picker as "not yet"', async () => {
    const pickFolder = vi.fn().mockRejectedValue(new DOMException('dismissed', 'AbortError'));
    const { send, makeReceiver } = pair({ pickFolder, canPickFolder: () => true });
    send.share(items());
    openLink(send.link ?? '');
    const receive = makeReceiver();
    expect(receive.canPickFolder).toBe(true);
    void receive.start();
    await until(() => send.confirming);
    send.approve();
    await until(() => receive.phase === 'reviewing');
    expect(await receive.accept('folder')).toBe(false);
    expect(receive.phase).toBe('reviewing');
    receive.cancel();
    await until(() => send.phase === 'cancelled');
  });

  it('lets several devices download from one link, each approved on its own', async () => {
    const { send, makeReceiver } = pair();
    send.share(items());
    send.setMulti(true);
    await until(() => send.phase === 'waiting');
    openLink(send.link ?? '');
    const [a, b] = [makeReceiver(), makeReceiver()];
    void a.start();
    void b.start();

    await until(() => send.pending.length === 2);
    expect(send.phase).toBe('waiting'); // the share stays up
    expect(send.pending.map((p) => p.key)).toEqual([1, 2]);
    send.decline(2);
    send.approve(); // the oldest: device 1
    await until(() => a.phase === 'reviewing' && b.phase === 'declined');
    expect(send.busy).toBe(true);
    await a.accept('download');
    await until(() => a.phase === 'done' && send.receivers[0]?.phase === 'done');
    expect(send.receivers.map((r) => r.phase)).toEqual(['done', 'declined']);
    expect(send.busy).toBe(false);
    send.reset();
    expect(send.multi).toBe(false);
  });

  it('keeps going after the connection drops, showing "reconnecting" on both sides', async () => {
    const { send, makeReceiver, rtc } = pair();
    send.share([{ file: new File([new Uint8Array(3_000_000).fill(7)], 'big.bin'), path: 'big.bin' }]);
    openLink(send.link ?? '');
    const receive = makeReceiver();
    void receive.start();
    await until(() => send.confirming);
    send.approve();
    await until(() => receive.phase === 'reviewing');
    await receive.accept('download');
    const seen = { send: new Set<string>(), receive: new Set<string>() };
    let cut = false;
    await until(() => {
      seen.send.add(send.phase);
      seen.receive.add(receive.phase);
      if (!cut && receive.done > 1_000_000) {
        cut = true;
        rtc.peers.at(-1)?.sever();
      }
      return receive.phase === 'done' && send.phase === 'done';
    }, 8000);
    expect(seen.receive.has('reconnecting')).toBe(true);
    expect(seen.send.has('reconnecting')).toBe(true);
    const files = receive.savedTo?.kind === 'download' ? receive.savedTo.files : [];
    const got = new Uint8Array(await ((await files[0]?.get()) ?? new Blob()).arrayBuffer());
    expect(got.byteLength).toBe(3_000_000);
    expect(got.every((x) => x === 7)).toBe(true);
  });

  it('tells a second device that the sender is busy', async () => {
    const { send, makeReceiver } = pair();
    send.share(items());
    openLink(send.link ?? '');
    const first = makeReceiver();
    void first.start();
    await until(() => send.confirming);
    const second = makeReceiver();
    await second.start();
    expect([second.phase, second.error]).toEqual(['failed', 'LINK_BUSY']);
    send.reset();
  });

  it('fails clearly without a link and when signaling cannot start', async () => {
    const receive = new ReceiveController({ createSignaling: async () => Promise.reject(new Error('x')) });
    await receive.start();
    expect([receive.phase, receive.error]).toEqual(['failed', 'LINK_INVALID']);

    openLink(encodeLink('https://x/', generateSecret()));
    await receive.start();
    expect([receive.phase, receive.error]).toEqual(['failed', 'PROTOCOL_ERROR']);

    const send = new SendController({ createSignaling: async () => Promise.reject(new Error('x')) });
    send.share(items());
    await until(() => send.phase === 'failed');
    send.share([]); // ignored
    expect(send.error).toBe('PROTOCOL_ERROR');
  });
});
