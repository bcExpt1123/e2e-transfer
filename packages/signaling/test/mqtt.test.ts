import { describe, expect, it } from 'vitest';
import { mqttSignaling } from '../src/mqtt/index.ts';
import { connect, PacketReader, parsePublish, publish, subscribe } from '../src/mqtt/packets.ts';
import { signalingContract } from './contract.ts';
import { FakeBroker, fakeBrokers } from './fake-broker.ts';

signalingContract('mqtt', () => {
  const net = fakeBrokers(new FakeBroker('wss://a'), new FakeBroker('wss://b'));
  return [mqttSignaling(net), mqttSignaling(net)];
});

const until = async (cond: () => boolean) => {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
};

describe('MQTT codec', () => {
  it('encodes CONNECT and SUBSCRIBE per MQTT 3.1.1', () => {
    expect([...connect('ab', 30)]).toEqual([
      0x10, 14, 0, 4, 0x4d, 0x51, 0x54, 0x54, 4, 0x02, 0, 30, 0, 2, 0x61, 0x62,
    ]);
    expect([...subscribe(1, 't')]).toEqual([0x82, 6, 0, 1, 0, 1, 0x74, 0]);
  });

  it('uses multi-byte remaining lengths and reassembles split packets', () => {
    const big = publish('t', new Uint8Array(300).fill(7));
    expect([...big.subarray(0, 3)]).toEqual([0x30, 0xaf, 0x02]); // 303 = 47 + 2*128
    const reader = new PacketReader();
    expect(reader.push(big.subarray(0, 2))).toEqual([]);
    expect(reader.push(big.subarray(2, 100))).toEqual([]);
    const [p] = reader.push(big.subarray(100));
    expect(p?.type).toBe(3);
    const { topic, payload } = parsePublish(p?.body ?? new Uint8Array(), p?.flags ?? 0);
    expect(topic).toBe('t');
    expect(payload).toEqual(new Uint8Array(300).fill(7));
  });

  it('splits several packets in one frame and rejects malformed lengths', () => {
    const two = new Uint8Array([0xd0, 0, 0x20, 2, 0, 0]);
    expect(new PacketReader().push(two).map((p) => p.type)).toEqual([13, 2]);
    expect(() => new PacketReader().push(Uint8Array.of(0x30, 0xff, 0xff, 0xff, 0xff, 1))).toThrow();
  });

  it('skips the packet id of QoS 1 publishes', () => {
    const body = Uint8Array.of(0, 1, 0x74, 0, 9, 42);
    expect(parsePublish(body, 0x02).payload).toEqual(Uint8Array.of(42));
  });
});

describe('mqtt adapter', () => {
  it('publishes to every broker, filters echoes and duplicates', async () => {
    const a = new FakeBroker('wss://a');
    const b = new FakeBroker('wss://b');
    const net = fakeBrokers(a, b);
    const ra = await mqttSignaling(net).join('room');
    const rb = await mqttSignaling(net).join('room');
    await until(() => a.sockets.size + b.sockets.size === 4);
    const atA: Uint8Array[] = [];
    const atB: Uint8Array[] = [];
    ra.onMessage((p) => atA.push(p));
    rb.onMessage((p) => atB.push(p));
    await ra.send(Uint8Array.of(5, 6));
    await until(() => atB.length > 0);
    await new Promise((r) => setTimeout(r, 20));
    expect(atB).toEqual([Uint8Array.of(5, 6)]);
    expect(atA).toEqual([]);
    expect(a.published).toEqual(['e2e-transfer/v1/room']);
    expect([...a.sockets][0]?.clientId).toMatch(/^e2et-/);
    await ra.leave();
    await rb.leave();
    await ra.leave();
  });

  it('survives dead brokers, keeps the connection alive, and fails clearly when all are gone', async () => {
    const good = new FakeBroker('wss://good');
    const net = fakeBrokers(
      new FakeBroker('wss://down', 'refuse'),
      new FakeBroker('wss://no', 'reject-connect'),
      good,
    );
    const room = await mqttSignaling({ ...net, keepAliveS: 0.05 }).join('t');
    await until(() => [...good.sockets].some((s) => s.pings > 0));
    for (const s of [...good.sockets]) s.drop();
    await expect(room.send(Uint8Array.of(1))).rejects.toMatchObject({ code: 'SIGNALING_UNREACHABLE' });
    await room.leave();

    const dead = fakeBrokers(
      new FakeBroker('wss://x', 'refuse'),
      new FakeBroker('wss://y', 'reject-connect'),
    );
    await expect(mqttSignaling({ ...dead, connectTimeoutMs: 50 }).join('t')).rejects.toMatchObject({
      code: 'SIGNALING_UNREACHABLE',
    });
  });

  it('requires a broker', () => {
    expect(() => mqttSignaling({ brokers: [] })).toThrow(RangeError);
  });
});
