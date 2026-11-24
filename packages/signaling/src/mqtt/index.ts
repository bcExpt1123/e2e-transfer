/**
 * Fallback signaling over public MQTT brokers (MQTT 3.1.1 over WebSocket, QoS 0),
 * topic `e2e-transfer/v1/<topic>`. Like the Nostr adapter: ready when one broker
 * connects, publishes to all, and drops duplicates and our own echoes.
 */
import {
  ErrorCode,
  type Signaling,
  type SignalingRoom,
  TransferError,
  toBase64Url,
  toHex,
} from '@e2e-transfer/core';
import { type RelayStatusListener, reportAttempt } from '../shared/health.ts';
import * as mqtt from './packets.ts';

export interface BinarySocketLike {
  readonly readyState: number;
  binaryType: BinaryType;
  onopen: ((ev: Event) => void) | null;
  onmessage: ((ev: MessageEvent) => void) | null;
  onclose: ((ev: CloseEvent) => void) | null;
  onerror: ((ev: Event) => void) | null;
  send(data: Uint8Array<ArrayBuffer>): void;
  close(): void;
}

export interface MqttOptions {
  brokers: readonly string[];
  connectTimeoutMs?: number;
  keepAliveS?: number;
  createSocket?: (url: string) => BinarySocketLike;
  /** How each broker's connection attempt went (feeds RelayHealth). */
  onRelayStatus?: RelayStatusListener;
}

export const DEFAULT_BROKERS: readonly string[] = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://test.mosquitto.org:8081/mqtt',
];

const OPEN = 1;
const ID_BYTES = 8; // sender id, then message id: 16-byte prefix on every payload
const MAX_SEEN = 2048;

export function mqttSignaling(opts: MqttOptions): Signaling {
  if (opts.brokers.length === 0) throw new RangeError('mqtt: no brokers configured');
  return { id: 'mqtt', join: (topic) => joinRoom(topic, opts) };
}

async function joinRoom(topic: string, opts: MqttOptions): Promise<SignalingRoom> {
  const fullTopic = `e2e-transfer/v1/${topic}`;
  const me = crypto.getRandomValues(new Uint8Array(ID_BYTES));
  const meHex = toHex(me);
  const create =
    opts.createSocket ?? ((url: string) => new WebSocket(url, 'mqtt') as unknown as BinarySocketLike);
  const timeoutMs = opts.connectTimeoutMs ?? 6_000;
  const keepAliveS = opts.keepAliveS ?? 30;
  const listeners = new Set<(payload: Uint8Array) => void>();
  const seen = new Set<string>();
  const sockets = new Set<BinarySocketLike>();
  const timers = new Set<ReturnType<typeof setInterval>>();
  let left = false;

  const onPayload = (data: Uint8Array) => {
    if (data.length <= 2 * ID_BYTES) return;
    const from = toHex(data.subarray(0, ID_BYTES));
    if (from === meHex) return; // brokers echo our own publishes
    const key = toHex(data.subarray(0, 2 * ID_BYTES));
    if (seen.has(key)) return; // same message via another broker
    if (seen.size >= MAX_SEEN) seen.clear();
    seen.add(key);
    const payload = data.slice(2 * ID_BYTES);
    for (const cb of [...listeners]) cb(payload);
  };

  const connectOne = (url: string) =>
    new Promise<BinarySocketLike>((resolve, reject) => {
      let ws: BinarySocketLike;
      try {
        ws = create(url);
      } catch (err) {
        reject(err);
        return;
      }
      ws.binaryType = 'arraybuffer';
      const reader = new mqtt.PacketReader();
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error(`${url}: timeout`));
      }, timeoutMs);
      ws.onopen = () => {
        ws.send(mqtt.connect(`e2et-${toBase64Url(crypto.getRandomValues(new Uint8Array(9)))}`, keepAliveS));
      };
      ws.onmessage = (e) => {
        if (!(e.data instanceof ArrayBuffer)) return;
        let packets: mqtt.Packet[];
        try {
          packets = reader.push(new Uint8Array(e.data));
        } catch {
          ws.close();
          return;
        }
        for (const p of packets) {
          if (p.type === mqtt.PacketType.Connack) {
            if (p.body[1] !== 0 || left) {
              clearTimeout(timer);
              ws.close();
              reject(new Error(`${url}: refused`));
              continue;
            }
            ws.send(mqtt.subscribe(1, fullTopic));
          } else if (p.type === mqtt.PacketType.Suback) {
            clearTimeout(timer);
            sockets.add(ws);
            const ping = setInterval(
              () => {
                if (ws.readyState === OPEN) ws.send(mqtt.pingreq());
              },
              keepAliveS * 1000 * 0.8,
            );
            timers.add(ping);
            resolve(ws);
          } else if (p.type === mqtt.PacketType.Publish) {
            const { topic: t, payload } = mqtt.parsePublish(p.body, p.flags);
            if (t === fullTopic) onPayload(payload);
          }
        }
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error(`${url}: error`));
      };
      ws.onclose = () => {
        clearTimeout(timer);
        sockets.delete(ws);
        reject(new Error(`${url}: closed`));
      };
    });

  const attempts = opts.brokers.map((url) =>
    reportAttempt(url, connectOne(url), opts.onRelayStatus, () => left),
  );
  for (const a of attempts) a.catch(() => {});
  try {
    await Promise.any(attempts);
  } catch (cause) {
    throw new TransferError(ErrorCode.SignalingUnreachable, 'no MQTT broker reachable', { cause });
  }

  return {
    async send(payload) {
      if (left) return;
      const msgId = crypto.getRandomValues(new Uint8Array(ID_BYTES));
      const body = new Uint8Array(2 * ID_BYTES + payload.length);
      body.set(me);
      body.set(msgId, ID_BYTES);
      body.set(payload, 2 * ID_BYTES);
      const frame = mqtt.publish(fullTopic, body);
      let sent = 0;
      for (const ws of sockets) {
        if (ws.readyState !== OPEN) continue;
        ws.send(frame);
        sent++;
      }
      if (sent === 0)
        throw new TransferError(ErrorCode.SignalingUnreachable, 'all MQTT brokers disconnected');
    },
    onMessage(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    async leave() {
      if (left) return;
      left = true;
      listeners.clear();
      for (const t of timers) clearInterval(t);
      timers.clear();
      for (const ws of sockets) {
        if (ws.readyState === OPEN) ws.send(mqtt.disconnect());
        ws.close();
      }
      sockets.clear();
    },
  };
}
