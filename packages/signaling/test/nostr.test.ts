import { describe, expect, it } from 'vitest';
import { nostrSignaling } from '../src/nostr/index.ts';
import { signalingContract } from './contract.ts';
import { FakeRelay, fakeNetwork } from './fake-relay.ts';

signalingContract('nostr', () => {
  const net = fakeNetwork(new FakeRelay('wss://a'), new FakeRelay('wss://b'));
  return [nostrSignaling(net), nostrSignaling(net)];
});

const until = async (cond: () => boolean) => {
  for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
};

describe('nostr adapter', () => {
  it('publishes signed ephemeral events to every relay and delivers each payload once', async () => {
    const a = new FakeRelay('wss://a');
    const b = new FakeRelay('wss://b');
    const net = fakeNetwork(a, b);
    const ra = await nostrSignaling(net).join('topic');
    const rb = await nostrSignaling(net).join('topic');
    await until(() => a.sockets.size + b.sockets.size === 4);
    const got: Uint8Array[] = [];
    rb.onMessage((p) => got.push(p));
    await ra.send(Uint8Array.of(1, 2, 3));
    await until(() => got.length > 0);
    await new Promise((r) => setTimeout(r, 20));
    expect(got).toEqual([Uint8Array.of(1, 2, 3)]);
    expect(a.events).toHaveLength(1);
    expect(b.events).toHaveLength(1);
    expect(a.rejected + b.rejected).toBe(0);
    expect(a.events[0]?.kind).toBeGreaterThanOrEqual(20000);
    expect(a.events[0]?.kind).toBeLessThan(30000);
    // a fresh throwaway key per join
    const rc = await nostrSignaling(net).join('topic');
    await rc.send(Uint8Array.of(4));
    await until(() => a.events.length > 1);
    expect(a.events[1]?.pubkey).not.toBe(a.events[0]?.pubkey);
    await Promise.all([ra.leave(), rb.leave(), rc.leave()]);
  });

  it('works while some relays are down, and fails clearly when all are', async () => {
    const good = new FakeRelay('wss://good');
    const net = fakeNetwork(
      new FakeRelay('wss://down', 'refuse'),
      new FakeRelay('wss://slow', 'silent'),
      good,
    );
    const room = await nostrSignaling({ ...net, connectTimeoutMs: 50 }).join('t');
    await room.send(Uint8Array.of(1));
    await until(() => good.events.length > 0);
    expect(good.events).toHaveLength(1);
    await room.leave();

    const dead = fakeNetwork(new FakeRelay('wss://x', 'refuse'), new FakeRelay('wss://y', 'silent'));
    await expect(nostrSignaling({ ...dead, connectTimeoutMs: 50 }).join('t')).rejects.toMatchObject({
      code: 'SIGNALING_UNREACHABLE',
    });
  });

  it('reports SIGNALING_UNREACHABLE when every relay has dropped', async () => {
    const r = new FakeRelay('wss://r');
    const room = await nostrSignaling(fakeNetwork(r)).join('t');
    for (const s of [...r.sockets]) s.drop();
    await expect(room.send(Uint8Array.of(1))).rejects.toMatchObject({ code: 'SIGNALING_UNREACHABLE' });
  });

  it('ignores malformed relay traffic', async () => {
    const r = new FakeRelay('wss://r');
    const room = await nostrSignaling(fakeNetwork(r)).join('t');
    const got: Uint8Array[] = [];
    room.onMessage((p) => got.push(p));
    const [sock] = [...r.sockets];
    if (!sock) throw new Error('no socket');
    const subId = [...sock.subs.keys()][0];
    sock.onmessage?.(new MessageEvent('message', { data: 'not json' }));
    sock.deliver(['NOTICE', 'hello']);
    sock.deliver(['EVENT', subId, { id: 1 }]);
    sock.deliver([
      'EVENT',
      subId,
      { id: 'x', pubkey: 'p', kind: 25050, tags: [['t', 'other']], content: 'AQ' },
    ]);
    sock.deliver(['EVENT', subId, { id: 'y', pubkey: 'p', kind: 25050, tags: [['t', 't']], content: '!!' }]);
    sock.deliver(['EVENT', subId, { id: 'z', pubkey: 'p', kind: 25050, tags: [['t', 't']], content: 'AQ' }]);
    await until(() => got.length > 0);
    expect(got).toEqual([Uint8Array.of(1)]);
    await room.leave();
    await room.leave();
  });

  it('requires at least one relay', () => {
    expect(() => nostrSignaling({ relays: [] })).toThrow(RangeError);
  });
});
