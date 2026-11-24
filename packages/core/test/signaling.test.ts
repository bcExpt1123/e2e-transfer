import { describe, expect, it } from 'vitest';
import { deriveLinkKeys, generateSecret, type SignalMessage, SignalSession } from '../src/index.ts';
import { memoryRoom } from './helpers.ts';

const SKEW = 120_000;
const tick = () => new Promise((r) => setTimeout(r, 20));
const until = async (cond: () => boolean) => {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
};

async function pairOfSessions(now?: () => number) {
  const { signalKey } = await deriveLinkKeys(generateSecret());
  const hub = memoryRoom();
  const opts = now ? { maxSkewMs: SKEW, now } : { maxSkewMs: SKEW };
  const a = new SignalSession(hub.join(), signalKey, opts);
  const b = new SignalSession(hub.join(), signalKey, opts);
  return { a, b, hub, signalKey };
}

function collect(s: SignalSession) {
  const got: SignalMessage[] = [];
  s.on((m) => got.push(m));
  return got;
}

describe('SignalSession', () => {
  it('delivers authenticated messages and never echoes to the author', async () => {
    const { a, b } = await pairOfSessions();
    const atA = collect(a);
    const atB = collect(b);
    await a.send('join');
    await a.send('offer', { sdp: 'x' }, b.id);
    await until(() => atB.length >= 2);
    expect(atB).toEqual([
      { from: a.id, t: 'join', d: {} },
      { from: a.id, to: b.id, t: 'offer', d: { sdp: 'x' } },
    ]);
    expect(atA).toEqual([]);
  });

  it('relays only ever see ciphertext', async () => {
    const { a, hub } = await pairOfSessions();
    await a.send('offer', { sdp: 'v=0 secret-fingerprint' });
    const wire = new TextDecoder().decode(hub.log[0]);
    expect(wire).not.toContain('secret-fingerprint');
    expect(wire).not.toContain(a.id);
  });

  it('ignores messages addressed to someone else', async () => {
    const { a, b } = await pairOfSessions();
    const atB = collect(b);
    await a.send('answer', { sdp: 'x' }, 'someone-else');
    await tick();
    expect(atB).toEqual([]);
  });

  it('drops replays, tampering, other secrets and stale timestamps', async () => {
    let clock = 1_000_000;
    const { a, b, hub } = await pairOfSessions(() => clock);
    const atB = collect(b);
    await a.send('join');
    await until(() => atB.length >= 1);
    expect(atB).toHaveLength(1);

    // replay the exact same bytes
    const [first] = hub.log;
    if (!first) throw new Error('nothing sent');
    hub.inject(first);
    // tamper
    const bad = first.slice();
    bad[bad.length - 1] = (bad[bad.length - 1] ?? 0) ^ 1;
    hub.inject(bad);
    // garbage and too-short
    hub.inject(new Uint8Array(5));
    hub.inject(crypto.getRandomValues(new Uint8Array(80)));
    // another secret in the same topic
    const stranger = new SignalSession(hub.join(), (await deriveLinkKeys(generateSecret())).signalKey, {
      maxSkewMs: SKEW,
    });
    await stranger.send('join');
    await tick();
    expect(atB).toHaveLength(1);

    // stale: author's clock is far behind ours
    clock -= SKEW + 1;
    await a.send('join');
    clock += SKEW + 1;
    await tick();
    expect(atB).toHaveLength(1);
  });

  it('rejects well-encrypted but malformed plaintext', async () => {
    const { b, hub, signalKey } = await pairOfSessions();
    const atB = collect(b);
    for (const body of [
      { from: 'x', seq: 0, ts: Date.now(), t: 'evil', d: {} },
      { from: 'x', seq: 0, ts: Date.now(), t: 'join', d: [] },
      { from: 1, seq: 0, ts: Date.now(), t: 'join', d: {} },
      'not an object',
    ]) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode('sig/v1') },
        signalKey,
        new TextEncoder().encode(JSON.stringify(body)),
      );
      const env = new Uint8Array(12 + ct.byteLength);
      env.set(iv);
      env.set(new Uint8Array(ct), 12);
      hub.inject(env);
    }
    await tick();
    expect(atB).toEqual([]);
  });

  it('stops sending and receiving after close()', async () => {
    const { a, b, hub } = await pairOfSessions();
    const atB = collect(b);
    await b.close();
    await b.close(); // idempotent
    await a.send('join');
    const sentBefore = hub.log.length;
    await b.send('join');
    await tick();
    expect(atB).toEqual([]);
    expect(hub.log.length).toBe(sentBefore);
  });
});
