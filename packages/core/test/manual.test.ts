import { describe, expect, it } from 'vitest';
import {
  bytesSource,
  deriveLinkKeys,
  encodeLink,
  generateSecret,
  type LinkOptions,
  LinkReceiver,
  LinkSender,
  openSdp,
  parseLink,
  type Signaling,
  sealSdp,
} from '../src/index.ts';
import { fakeRtc } from '../src/testing/index.ts';
import { codeOf, patternBytes } from './helpers.ts';
import { MemorySink } from './memory-sink.ts';

const noSignaling: Signaling = {
  id: 'none',
  join: () => Promise.reject(new Error('manual mode must not touch signaling')),
};

function base(secret = generateSecret()): LinkOptions {
  return {
    secret,
    signaling: noSignaling,
    rtc: fakeRtc(),
    iceServers: [],
    config: { closeGraceMs: 200 },
    timeouts: { connectTimeoutMs: 2_000 },
  };
}

const nextCode = (s: { on(e: 'code', cb: (c: string) => void): unknown }) =>
  new Promise<string>((resolve) => s.on('code', resolve));

describe('manual connect (no signaling network)', () => {
  it('transfers with the offer in the link and the reply pasted back', async () => {
    const opts = base();
    const src = patternBytes(200_000, 3);
    const sender = new LinkSender({ ...opts, manual: true, files: [bytesSource(src, 'm.bin')] });
    const phases: string[] = [];
    sender.on('phase', (p) => phases.push(p));
    const offerCode = nextCode(sender);
    const sending = sender.start();

    const link = encodeLink('https://app.example/', opts.secret, await offerCode);
    const parsed = parseLink(new URL(link).hash);
    expect(parsed.offer).toBe(await offerCode);

    const sink = new MemorySink();
    const receiver = new LinkReceiver({
      ...base(parsed.secret),
      ...(parsed.offer && { offer: parsed.offer }),
      onManifest: () => ({ sink }),
    });
    const replyCode = nextCode(receiver);
    const receiving = receiver.start();

    expect(await sender.acceptReply('garbage!')).toBe(false); // user pasted the wrong thing
    expect(await sender.acceptReply(await replyCode)).toBe(true);
    expect(await sender.acceptReply(await replyCode)).toBe(true); // double paste is harmless

    await expect(receiving).resolves.toBe('completed');
    await sending;
    const blob = sink.files.get('m.bin');
    expect(blob && new Uint8Array(await blob.arrayBuffer())).toEqual(src);
    expect(phases.slice(0, 4)).toEqual(['joining', 'waiting', 'connecting', 'handshaking']);
  });

  it('rejects codes from another link and damaged offers', async () => {
    const opts = base();
    const sender = new LinkSender({ ...opts, manual: true, files: [bytesSource(new Uint8Array(1), 'x')] });
    const offerCode = nextCode(sender);
    const sending = sender.start();

    // a receiver with a different secret can't read the offer
    const stranger = new LinkReceiver({ ...base(), offer: await offerCode, onManifest: () => null });
    await expect(stranger.start()).rejects.toMatchObject({ code: 'LINK_INVALID' });

    // a reply sealed with another link's key is refused
    const other = await deriveLinkKeys(generateSecret());
    expect(await sender.acceptReply(await sealSdp(other.signalKey, 'answer', 'v=0'))).toBe(false);
    sender.cancel();
    await expect(sending).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('seals SDP compactly and refuses swapped kinds', async () => {
    const { signalKey } = await deriveLinkKeys(generateSecret());
    const sdp = `v=0\r\n${'a=candidate:1 1 udp 2122260223 192.168.1.10 54321 typ host\r\n'.repeat(8)}`;
    const code = await sealSdp(signalKey, 'offer', sdp);
    expect(code.length).toBeLessThan(sdp.length / 2);
    expect(await openSdp(signalKey, 'offer', code)).toBe(sdp);
    await expect(openSdp(signalKey, 'answer', code)).rejects.toMatchObject({ code: 'LINK_INVALID' });
    await expect(openSdp(signalKey, 'offer', 'x'.repeat(20_000))).rejects.toMatchObject({
      code: 'LINK_INVALID',
    });
  });

  it('can be cancelled by the receiver while waiting for the sender', async () => {
    const opts = base();
    const sender = new LinkSender({ ...opts, manual: true, files: [bytesSource(new Uint8Array(1), 'x')] });
    const offerCode = nextCode(sender);
    const sending = sender.start();
    const receiver = new LinkReceiver({
      ...base(opts.secret),
      offer: await offerCode,
      onManifest: () => null,
    });
    receiver.on('phase', (p) => p === 'waiting' && receiver.cancel());
    const [r] = await Promise.allSettled([receiver.start()]);
    expect(codeOf(r)).toBe('CANCELLED');
    sender.cancel();
    await expect(sending).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(
      await new LinkSender({ ...opts, files: [bytesSource(new Uint8Array(1), 'x')] }).acceptReply('x'),
    ).toBe(false);
  });
});
