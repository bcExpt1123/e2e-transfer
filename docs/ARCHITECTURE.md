# Architecture

## Goals and non-goals

**Goals**
- Move files of any size between two browsers, directly and end-to-end encrypted.
- Operate no backend. The deployable output is a static `dist/` folder.
- Keep the core framework-agnostic and the external dependencies (signaling, storage, key exchange) swappable
  (ports and adapters).
- Provide a polished, accessible UI ([UX.md](UX.md)) on a codebase that is cheap to change ([MAINTAINABILITY.md](MAINTAINABILITY.md)).

**Non-goals (for now)**
- Store-and-forward or offline delivery. Both peers must be online at the same time.
- Native apps or a CLI. The protocol is documented so that they could be built later.
- Guaranteed connectivity behind symmetric NATs without a TURN server. See [NAT traversal](#nat-traversal).

## Component overview

```
┌──────────────────────────── apps/web (Svelte) ────────────────────────────┐
│  features/  send · receive · settings        (screens, feature components) │
│  lib/ui     design system (tokens, Button, Card, Progress, Dialog, …)      │
│  lib/state  TransferController: core events → reactive $state + commands  │
└───────────────┬───────────────────────────────────────────────────────────┘
                │ uses (only via lib/state)
┌───────────────▼──────────────── packages/core ────────────────────────────┐
│  Session (state machine)                                                   │
│   ├─ keys.ts        secret → HKDF tree (roomTopic, signalKey, sessionKeys) │
│   ├─ peer.ts        RTCPeerConnection + DataChannel, ICE, backpressure     │
│   ├─ protocol.ts    frame codec (header + AES-GCM payload)                 │
│   ├─ sender.ts      reads Files → CHUNK frames                             │
│   └─ receiver.ts    CHUNK frames → FileSink                                │
└───────┬──────────────────────────────────────────────┬────────────────────┘
        │ Signaling interface                          │ FileSink interface
┌───────▼──────── packages/signaling ───┐   ┌──────────▼──── packages/storage ┐
│ nostr · mqtt · manual (QR/paste)      │   │ fs-access · opfs · memory        │
└───────────────────────────────────────┘   └──────────────────────────────────┘
```

Dependency rule: `apps/web → core → (signaling, storage interfaces only)`. Adapters depend only on the
interface types. `core` contains no DOM or UI code apart from the WebRTC and WebCrypto globals, which are injectable for tests.

## Session lifecycle

```
idle ─► joining ─► signaling ─► connecting ─► handshaking ─► awaiting-accept ─► transferring ─► done
                       │             │              │                 │                 │
                       └─────────────┴──────────────┴─────────────────┴──────► failed / cancelled
```

| State | Sender | Receiver |
|---|---|---|
| joining | create secret, join `roomTopic`, show link | parse `#secret`, join `roomTopic`, send `join` |
| signaling | on `join`: create offer | wait for offer, reply with answer |
| connecting | ICE / DTLS | ICE / DTLS |
| handshaking | exchange `HELLO` nonces → derive session keys | same |
| awaiting-accept | send `MANIFEST` | user accepts → `ACCEPT` (picks sink) |
| transferring | stream `CHUNK`s | write to sink, send `ACK`s |
| done | `DONE` received | all files closed |

Roles are fixed: **the sender always makes the offer**. That avoids glare handling ("perfect negotiation")
in v1. When the link is opened, the sender's UI asks for confirmation before sending `MANIFEST`, so a leaked link can't silently receive the file.

## Adapter interfaces

```ts
// packages/signaling
export interface Signaling {
  join(topic: string): Promise<SignalingRoom>;
}
export interface SignalingRoom {
  send(payload: Uint8Array): Promise<void>;          // already encrypted by core
  onMessage(cb: (payload: Uint8Array) => void): () => void;
  leave(): Promise<void>;
}
```

Adapters only move opaque bytes. All encryption, authentication, replay filtering and deduplication happen in `core`
(see [PROTOCOL.md § Signaling envelope](PROTOCOL.md#3-signaling-envelope)), so a new adapter can't weaken security.

| Adapter | Transport | Notes |
|---|---|---|
| `nostr` (default) | Ephemeral events (kind 20000–29999) on 3+ public relays, signed by a throwaway key | Redundant: publishes to all relays and dedupes on receipt |
| `mqtt` | `mqtt` over WSS to public brokers, topic `e2e-transfer/v1/<topic>` | Fallback when Nostr relays are blocked |
| `manual` | User copies text or scans a QR code each way | Fully serverless. Uses non-trickle ICE, so the complete SDP is gathered first. Compressed and base64url-encoded |

```ts
// packages/storage
export interface FileSink {
  /** Called once per file, after the user accepts. */
  open(meta: { path: string; size: number; mime: string }): Promise<SinkWriter>;
}
export interface SinkWriter {
  write(chunk: Uint8Array, offset: number): Promise<void>;
  close(): Promise<void>;
  abort(reason?: unknown): Promise<void>;
}
```

| Sink | Where | Memory | Browsers |
|---|---|---|---|
| `fs-access` | `showSaveFilePicker` / `showDirectoryPicker` | constant | Chromium |
| `opfs` | Origin Private File System, then download of the disk-backed `File` | constant | all modern browsers |
| `memory` | `Blob` assembled in RAM | O(file) | everything; tests and small files (< 256 MiB) |

The web app picks the best available sink at runtime.

## Data path and backpressure

```
File.slice() ─► encrypt (WebCrypto, async) ─► dc.send()
                                    ▲
           paused while dc.bufferedAmount > HIGH (4 MiB), resumed on 'bufferedamountlow' (LOW = 1 MiB)
```

- Chunk size is 60 KiB of plaintext, and frames stay ≤ 64 KiB, the safe cross-browser message size.
- One ordered, reliable DataChannel. Counter-based nonces reject any drop, reorder or replay.
- The receiver writes sequentially and sends `ACK{counter}` every 1 MiB. The sender uses ACKs for progress and for resume.
- WebCrypto already runs off the main thread in all major browsers, so v1 runs the engine on the main thread. A Worker is
  added only if profiling shows UI jank. Note that `RTCDataChannel` is not transferable in Chromium.

## NAT traversal

- ICE servers: public STUN by default (configurable list).
- TURN is optional and set by the user (URL, username, credential) in Settings, or supplied by a deployment at build time
  (`VITE_TURN_*`). Without TURN, roughly 10–20% of peer pairs (symmetric NAT, strict corporate firewalls) can't connect, and the UI reports this
  clearly instead of hanging. TURN only ever sees doubly encrypted bytes.

## Why this scales

| Load | Cost to us |
|---|---|
| Static assets | CDN, cacheable, effectively free |
| Signaling | A few KB per session on public relays. Spread across many relays and swappable |
| File bytes | Peer to peer: zero |
| TURN (optional) | Only for the minority who need it. Can be metered per deployment |

Each part that does hold state (relays, TURN) is an interchangeable adapter, so no single component limits growth.
To keep public relays from becoming a bottleneck:
- Publish to several relays at once and track per-relay health (latency, failures) in `localStorage`. Unhealthy relays are skipped.
- The relay list ships in config and can be overridden per deployment (`VITE_SIGNALING_RELAYS`) or per user in Settings.
- If the default adapter fails, fall back automatically: nostr → mqtt → manual QR.

### Scaling the codebase
- **Ports and adapters:** new networks, storage targets and key-exchange modes are new adapters. Nothing in core changes. See the
  extension-point table in [MAINTAINABILITY.md](MAINTAINABILITY.md#extension-points-how-the-app-grows-without-rewrites).
- **Versioned protocol:** HELLO carries the version, and future capability flags are negotiated, so old and new clients interoperate.
- **Lazy loading:** optional features (QR scanner, MQTT, PAKE) are dynamic imports, so the initial bundle doesn't grow as features are added.

## Testing strategy

- **Unit (Vitest):** key derivation vectors; frame codec round-trips; AEAD tamper, reorder and replay rejection;
  the sender and receiver engines wired together over an in-memory `LoopbackChannel` with backpressure simulation; the signaling envelope.
- **Adapter contract tests:** one shared suite that every `Signaling` and `FileSink` implementation must pass.
- **E2E (Playwright):** two browser contexts, a local in-process signaling adapter (`BroadcastChannel`) to avoid
  depending on public relays, and real WebRTC. Checks that the received bytes match the sent bytes. A nightly job also runs the test against real Nostr relays.
