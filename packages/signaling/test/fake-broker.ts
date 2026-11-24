import type { BinarySocketLike } from '../src/mqtt/index.ts';

/** In-memory MQTT 3.1.1 broker (QoS 0). Parses client packets independently of the adapter's codec. */
export class FakeBroker {
  readonly sockets = new Set<FakeMqttSocket>();
  readonly published: string[] = [];
  constructor(
    readonly url: string,
    readonly mode: 'ok' | 'refuse' | 'reject-connect' = 'ok',
  ) {}
}

const dec = new TextDecoder();
const readStr = (b: Uint8Array, at: number) => {
  const n = ((b[at] ?? 0) << 8) | (b[at + 1] ?? 0);
  return { s: dec.decode(b.subarray(at + 2, at + 2 + n)), next: at + 2 + n };
};

export class FakeMqttSocket implements BinarySocketLike {
  readyState = 0;
  binaryType: BinaryType = 'blob';
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  readonly topics = new Set<string>();
  clientId = '';
  pings = 0;

  constructor(readonly broker: FakeBroker) {
    setTimeout(() => {
      if (broker.mode === 'refuse') {
        this.readyState = 3;
        this.onerror?.(new Event('error'));
        this.onclose?.(new Event('close') as CloseEvent);
        return;
      }
      this.readyState = 1;
      broker.sockets.add(this);
      this.onopen?.(new Event('open'));
    }, 0);
  }

  send(data: Uint8Array) {
    if (this.readyState !== 1) throw new Error('not open');
    // single packet per frame; remaining length assumed < 16384 (2 bytes)
    const type = (data[0] ?? 0) >> 4;
    let i = 1;
    while ((data[i] ?? 0) & 0x80) i++;
    const body = data.subarray(i + 1);
    if (type === 1) {
      const proto = readStr(body, 0);
      if (proto.s !== 'MQTT' || body[proto.next] !== 4) throw new Error('bad CONNECT');
      this.clientId = readStr(body, proto.next + 4).s;
      this.reply(Uint8Array.of(0x20, 2, 0, this.broker.mode === 'reject-connect' ? 5 : 0));
    } else if (type === 8) {
      if (((data[0] ?? 0) & 0x0f) !== 2) throw new Error('bad SUBSCRIBE flags');
      this.topics.add(readStr(body, 2).s);
      this.reply(Uint8Array.of(0x90, 3, body[0] ?? 0, body[1] ?? 0, 0));
    } else if (type === 3) {
      const { s: topic } = readStr(body, 0);
      this.broker.published.push(topic);
      for (const sock of this.broker.sockets) if (sock.topics.has(topic)) sock.reply(data.slice()); // echoes to author too
    } else if (type === 12) {
      this.pings++;
      this.reply(Uint8Array.of(0xd0, 0));
    } else if (type === 14) {
      this.close();
    }
  }

  reply(bytes: Uint8Array) {
    if (this.readyState !== 1) return;
    const buf = bytes.slice().buffer;
    setTimeout(() => this.onmessage?.(new MessageEvent('message', { data: buf })), 0);
  }

  drop() {
    this.readyState = 3;
    this.broker.sockets.delete(this);
    this.onclose?.(new Event('close') as CloseEvent);
  }

  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.broker.sockets.delete(this);
    setTimeout(() => this.onclose?.(new Event('close') as CloseEvent), 0);
  }
}

export function fakeBrokers(...brokers: FakeBroker[]) {
  const byUrl = new Map(brokers.map((b) => [b.url, b]));
  return {
    brokers: brokers.map((b) => b.url),
    createSocket: (url: string) => {
      const b = byUrl.get(url);
      if (!b) throw new Error(`unknown broker ${url}`);
      return new FakeMqttSocket(b);
    },
  };
}
