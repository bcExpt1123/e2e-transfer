# e2e-transfer

**Peer-to-peer, end-to-end encrypted file transfer in the browser. No accounts, no uploads, no server of our own.**

Open the app and drop in a file. Share the link (or, later, a short code like `7-guitar-orbit`). The bytes go directly from one browser to the other over WebRTC, encrypted with a key that never leaves the two devices.

> Status: **design phase**. This README and [`/docs`](docs/) are the plan. Code follows the [roadmap](docs/ROADMAP.md).

---

## How it works

```
 Sender browser                                             Receiver browser
 ──────────────                                             ────────────────
 1. secret = random 32 bytes
    link  = https://app/#<secret>   ── shared out of band ──►  opens link
                                                               (fragment is never sent to any server)
 2. both derive from secret (HKDF):  roomTopic · signalKey · (session keys later)

 3. signaling ──► public relays (Nostr / MQTT) ◄── signaling
    SDP offer/answer + ICE, encrypted with signalKey
    (relays see opaque blobs on a random-looking topic)

 4. ═══════════ WebRTC DataChannel (direct P2P, DTLS) ═══════════
    every frame additionally AES-256-GCM encrypted with per-session keys
    chunked · back-pressured · streamed straight to disk
```

- **Serverless:** the app is static files on a CDN. Signaling uses existing public relays through pluggable adapters, and manual copy-paste or QR code also works with no relay at all.
- **End-to-end:** encryption sits at the application layer _on top of_ DTLS. Relays, STUN or TURN servers, and the CDN can't read file contents or names, and can't tamper with them.
- **Scalable:** data flows peer to peer, so each extra user costs nothing. The architecture is modular: signaling, key exchange and storage are all swappable adapters, so new networks, storage targets or key modes plug in without touching the core.
- **Good UX:** one obvious action per screen, a clear status for every step, and errors that say what to do next. Accessible (WCAG 2.2 AA), mobile-first, dark mode, and installable as a PWA. See [docs/UX.md](docs/UX.md).
- **Maintainable:** strict TypeScript, layer boundaries enforced in CI, contract tests for every adapter, and size and a11y budgets. See [docs/MAINTAINABILITY.md](docs/MAINTAINABILITY.md).

## Features

|                                                          | Phase   |
| -------------------------------------------------------- | ------- |
| Send files to a peer via a secret link                   | 3 (MVP) |
| Multiple files and folders, progress, speed, ETA, cancel | 3–4     |
| Multi-GB files streamed to disk (no RAM limit)           | 3 (MVP) |
| Manual signaling (QR / copy-paste), no relay needed      | 4       |
| Short human codes using a PAKE (CPace)                   | 5       |
| Resume after disconnect, one-to-many, installable PWA    | 6       |

See [docs/ROADMAP.md](docs/ROADMAP.md) for the full plan.

## Tech stack

| Concern          | Choice                                                                                                          |
| ---------------- | --------------------------------------------------------------------------------------------------------------- |
| Language / build | TypeScript (strict), Vite, pnpm workspaces                                                                      |
| UI               | Svelte 5 (runes), Tailwind CSS v4 + design tokens, `bits-ui` (accessible headless primitives), `@lucide/svelte` |
| App shell        | `vite-plugin-pwa` (installable, offline), typed dependency-free i18n                                            |
| Transport        | Native `RTCPeerConnection` + `RTCDataChannel`                                                                   |
| Crypto           | WebCrypto (AES-256-GCM, HKDF-SHA-256); `@noble/curves` for the PAKE                                             |
| Signaling        | `nostr-tools` (default), `mqtt` over WSS, manual QR (`qrcode`, `jsQR`)                                          |
| Storage          | File System Access API → OPFS → in-memory Blob (small files)                                                    |
| Tests            | Vitest (unit, component), Playwright (real WebRTC, axe a11y, visual snapshots)                                  |
| Quality gates    | Biome, dependency-cruiser (layer rules), size-limit (bundle budget), Renovate, release-please                   |
| Hosting          | Any static host: GitHub Pages, Cloudflare Pages, Netlify                                                        |

The reasoning behind these choices is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/adr/](docs/adr/).

## Security in one paragraph

Whoever has the link can receive the file. Treat it like a password and send it over a channel you trust. The link's `#fragment` holds a 256-bit secret, and browsers never send the fragment to a server. Relays see only a topic derived from that secret plus ciphertext. Because signaling is authenticated with the secret, a relay can't swap DTLS fingerprints to put itself in the middle. File data is encrypted and authenticated frame by frame with keys that are fresh for every session. The full threat model, including what this does **not** protect against, is in [docs/SECURITY.md](docs/SECURITY.md).

## Quick start (once Phase 1 has landed)

```bash
pnpm install
pnpm dev            # http://localhost:5173 (open two windows: send and receive)
pnpm test           # unit tests
pnpm test:e2e       # Playwright: real transfer between two browser contexts
pnpm build          # static output in apps/web/dist
```

## Repository layout

```
apps/web/            Svelte UI: features/{send,receive,settings}, lib/{ui,state,i18n}
packages/core/       crypto, protocol, transfer engine, ports (adapter interfaces); framework-agnostic
packages/signaling/  Signaling adapters: memory, then nostr, mqtt, manual
packages/storage/    FileSink adapters: memory, then fs-access, opfs
tests/e2e/           Playwright tests
docs/                architecture, protocol, security, roadmap, ADRs
```

## Documentation

- [Architecture](docs/ARCHITECTURE.md): components, data flow, adapter interfaces
- [Protocol](docs/PROTOCOL.md): key derivation, signaling envelope, wire frames
- [UX & UI](docs/UX.md): flows, screens, microcopy, error catalog, a11y, performance budgets
- [Maintainability](docs/MAINTAINABILITY.md): layering rules, conventions, extension points, testing, workflow
- [Security](docs/SECURITY.md): threat model and guarantees
- [Roadmap](docs/ROADMAP.md): phases and acceptance criteria
- [Decision records](docs/adr/)

## License

MIT
