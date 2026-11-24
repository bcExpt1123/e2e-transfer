import { describe, expect, it } from 'vitest';
import { mqttSignaling } from '../src/mqtt/index.ts';
import { nostrSignaling } from '../src/nostr/index.ts';
import { type HealthStore, RelayHealth, type RelayRecord, type RelayStatus } from '../src/shared/health.ts';
import { FakeBroker, fakeBrokers } from './fake-broker.ts';
import { FakeRelay, fakeNetwork } from './fake-relay.ts';

function memoryStore(initial: Record<string, RelayRecord> = {}) {
  let saved = structuredClone(initial);
  const store: HealthStore = {
    load: () => structuredClone(saved),
    save: (r) => {
      saved = structuredClone(r);
    },
  };
  return { store, saved: () => saved };
}

describe('RelayHealth', () => {
  it('puts fast relays first, keeps untried ones in configured order', () => {
    const h = new RelayHealth();
    h.record({ url: 'wss://slow', ok: true, ms: 900 });
    h.record({ url: 'wss://fast', ok: true, ms: 80 });
    expect(h.rank(['wss://new1', 'wss://slow', 'wss://new2', 'wss://fast'])).toEqual([
      'wss://fast',
      'wss://slow',
      'wss://new1',
      'wss://new2',
    ]);
  });

  it('rests a relay after repeated failures, but never drops below the minimum', () => {
    let now = 1_000_000;
    const h = new RelayHealth(undefined, () => now);
    for (const url of ['wss://a', 'wss://a', 'wss://b']) h.record({ url, ok: false });
    expect(h.rank(['wss://a', 'wss://b', 'wss://c'], 2)).toEqual(['wss://b', 'wss://c']); // b failed once only
    h.record({ url: 'wss://b', ok: false });
    expect(h.rank(['wss://a', 'wss://b', 'wss://c'], 2)).toEqual(['wss://c', 'wss://a']); // a has rested longest
    expect(h.rank(['wss://a', 'wss://b', 'wss://c'], 1)).toEqual(['wss://c']);

    now += 31 * 60_000; // cooldown over: everyone gets another chance
    expect(h.rank(['wss://a', 'wss://b', 'wss://c'])).toHaveLength(3);
    h.record({ url: 'wss://a', ok: true, ms: 50 });
    expect(h.rank(['wss://a', 'wss://b'])[0]).toBe('wss://a');
  });

  it('smooths latency, persists, bounds its size and survives a broken store', () => {
    const { store, saved } = memoryStore();
    const h = new RelayHealth(store);
    h.record({ url: 'wss://x', ok: true, ms: 100 });
    h.record({ url: 'wss://x', ok: true, ms: 200 });
    expect(saved()['wss://x']).toEqual({ fails: 0, ms: 130 });
    expect(new RelayHealth(store).rank(['wss://y', 'wss://x'])[0]).toBe('wss://x');

    for (let i = 0; i < 60; i++) h.record({ url: `wss://r${i}`, ok: true, ms: i });
    expect(Object.keys(saved())).toHaveLength(50);
    expect(saved()['wss://x']).toBeUndefined(); // the oldest went first

    const broken: HealthStore = {
      load: () => {
        throw new Error('corrupt');
      },
      save: () => {
        throw new Error('full');
      },
    };
    const b = new RelayHealth(broken);
    b.record({ url: 'wss://z', ok: false });
    expect(b.rank(['wss://z', 'wss://z'])).toEqual(['wss://z']);
  });
});

describe('adapters report each relay', () => {
  const settle = () => new Promise((r) => setTimeout(r, 80));

  it('nostr: success with latency, failure for dead relays', async () => {
    const seen: RelayStatus[] = [];
    const net = fakeNetwork(new FakeRelay('wss://ok'), new FakeRelay('wss://down', 'refuse'));
    const room = await nostrSignaling({ ...net, onRelayStatus: (s) => seen.push(s) }).join('t');
    await settle();
    await room.leave();
    expect(seen.find((s) => s.url === 'wss://ok')).toMatchObject({ ok: true });
    expect(seen.find((s) => s.url === 'wss://down')).toEqual({ url: 'wss://down', ok: false });
  });

  it('mqtt: same, and attempts abandoned by leaving are not blamed on the broker', async () => {
    const seen: RelayStatus[] = [];
    const net = fakeBrokers(new FakeBroker('wss://ok'), new FakeBroker('wss://silent', 'silent'));
    const room = await mqttSignaling({
      ...net,
      connectTimeoutMs: 400,
      onRelayStatus: (s) => seen.push(s),
    }).join('t');
    await room.leave(); // the silent broker's attempt is still pending and times out after this
    await new Promise((r) => setTimeout(r, 500));
    expect(seen).toEqual([expect.objectContaining({ url: 'wss://ok', ok: true })]);
  });
});
