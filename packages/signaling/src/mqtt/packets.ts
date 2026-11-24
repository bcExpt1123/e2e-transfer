/**
 * The MQTT 3.1.1 subset we need (QoS 0 only): CONNECT, SUBSCRIBE, PUBLISH, PINGREQ, DISCONNECT
 * out; CONNACK, SUBACK, PUBLISH, PINGRESP in. Spec: docs.oasis-open.org/mqtt/mqtt/v3.1.1.
 */
export const PacketType = {
  Connect: 1,
  Connack: 2,
  Publish: 3,
  Subscribe: 8,
  Suback: 9,
  Pingreq: 12,
  Pingresp: 13,
  Disconnect: 14,
} as const;
export type PacketType = (typeof PacketType)[keyof typeof PacketType];

const enc = new TextEncoder();

function str(s: string): Uint8Array {
  const b = enc.encode(s);
  const out = new Uint8Array(2 + b.length);
  out[0] = b.length >> 8;
  out[1] = b.length & 0xff;
  out.set(b, 2);
  return out;
}

function varint(n: number): number[] {
  const out: number[] = [];
  do {
    let byte = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) byte |= 0x80;
    out.push(byte);
  } while (n > 0);
  return out;
}

function packet(header: number, ...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const head = [header, ...varint(len)];
  const out = new Uint8Array(head.length + len);
  out.set(head);
  let at = head.length;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export const connect = (clientId: string, keepAliveS: number) =>
  packet(
    PacketType.Connect << 4,
    str('MQTT'),
    Uint8Array.of(4, 0x02, keepAliveS >> 8, keepAliveS & 0xff), // level 4, clean session
    str(clientId),
  );

export const subscribe = (packetId: number, topic: string) =>
  packet(
    (PacketType.Subscribe << 4) | 0x02,
    Uint8Array.of(packetId >> 8, packetId & 0xff),
    str(topic),
    Uint8Array.of(0),
  );

export const publish = (topic: string, payload: Uint8Array) =>
  packet(PacketType.Publish << 4, str(topic), payload);

export const pingreq = () => Uint8Array.of(PacketType.Pingreq << 4, 0);
export const disconnect = () => Uint8Array.of(PacketType.Disconnect << 4, 0);

export interface Packet {
  type: PacketType;
  flags: number;
  body: Uint8Array;
}

/** Splits a byte stream into packets; keeps partial data until the rest arrives. */
export class PacketReader {
  #buf = new Uint8Array(0);

  push(data: Uint8Array): Packet[] {
    const merged = new Uint8Array(this.#buf.length + data.length);
    merged.set(this.#buf);
    merged.set(data, this.#buf.length);
    const out: Packet[] = [];
    let at = 0;
    for (;;) {
      if (merged.length - at < 2) break;
      let len = 0;
      let mul = 1;
      let i = at + 1;
      let complete = false;
      for (; i < merged.length && i < at + 5; i++) {
        const b = merged[i] ?? 0;
        len += (b & 0x7f) * mul;
        mul *= 128;
        if ((b & 0x80) === 0) {
          complete = true;
          break;
        }
      }
      if (!complete) {
        if (i >= at + 5) throw new Error('malformed MQTT length');
        break;
      }
      const start = i + 1;
      if (merged.length < start + len) break;
      const header = merged[at] ?? 0;
      out.push({
        type: (header >> 4) as PacketType,
        flags: header & 0x0f,
        body: merged.slice(start, start + len),
      });
      at = start + len;
    }
    this.#buf = merged.slice(at);
    return out;
  }
}

/** For PUBLISH (QoS 0): topic and payload. */
export function parsePublish(body: Uint8Array, flags: number): { topic: string; payload: Uint8Array } {
  const n = ((body[0] ?? 0) << 8) | (body[1] ?? 0);
  const topic = new TextDecoder().decode(body.subarray(2, 2 + n));
  const qos = (flags >> 1) & 0x03;
  const offset = 2 + n + (qos > 0 ? 2 : 0);
  return { topic, payload: body.slice(offset) };
}
