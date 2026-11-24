# Roadmap

Each phase ends with a demo and its acceptance criteria met in CI.

## Phase 0: Design ✅

README, [ARCHITECTURE](ARCHITECTURE.md), [PROTOCOL](PROTOCOL.md), [SECURITY](SECURITY.md), [UX](UX.md),
[MAINTAINABILITY](MAINTAINABILITY.md), [ADRs](adr/).

## Phase 1: Scaffold and design system ✅

- pnpm workspace: `apps/web`, `packages/{core,signaling,storage}`, `tests/e2e`.
- TypeScript strict config shared through `tsconfig.base.json`, plus Biome, Vitest, Playwright, lefthook, dependency-cruiser rules and size-limit.
- `apps/web` shell: Tailwind v4 + `tokens.css` (light and dark), base `lib/ui` components (Button, Card, Progress, Dialog,
  FileList, StatusStepper, Toast), typed i18n with English, and an app header with Settings and "How it works" dialogs.
- GitHub Actions: lint → typecheck → unit → dep-rules → build → size-limit → e2e (+ axe). Preview deploy per PR, `main` → GitHub Pages.

**Done when:** `pnpm install && pnpm lint && pnpm -r typecheck && pnpm test && pnpm build` passes on a clean checkout and in CI. The
shell scores ≥ 95 on Lighthouse performance and accessibility, and the bundle stays within the [UX budgets](UX.md#performance-budgets-enforced-in-ci).

## Phase 2: Core engine (no network) ✅

- `keys.ts`: the HKDF tree, with fixed test vectors.
- `protocol.ts`: frame encode/decode, AEAD, counters, HELLO.
- `sender.ts` / `receiver.ts` over a `MessageChannelLike` abstraction, plus a `LoopbackChannel` with simulated `bufferedAmount`.
- `storage/memory` sink (landed in phase 1).
- Flow-control window (`maxUnackedBytes`) so a slow disk cannot exhaust receiver memory (PROTOCOL §4.4).

**Done when:** unit tests transfer 3 files (0 B, 1 B, 50 MiB) through the loopback; any tampered, reordered or replayed frame fails; malicious paths are rejected.

## Phase 3: First real transfer (MVP) ✅ (field test pending)

- `peer.ts`: RTCPeerConnection, trickle ICE, DataChannel and backpressure.
- `signaling/nostr` adapter and the signaling envelope.
- `TransferController` (`lib/state`) and the full flows from [UX.md](UX.md): Pick → Share → Approve → Transfer → Done, and
  Connect → Review → Transfer → Done. Includes the error catalog, `beforeunload` guard, Wake Lock and title-bar progress.
- `storage/fs-access` and `storage/opfs` sinks with runtime selection.
- A Playwright e2e test using a `BroadcastChannel` signaling adapter.

**Done when:** two browsers on different networks transfer a 1 GiB file through the deployed site, with constant memory use on the receiver. The e2e test passes in Chromium and Firefox.

Status: the e2e tests pass in Chromium (desktop and mobile) and Firefox, using real WebRTC and OPFS. The
cross-network 1 GiB run needs the deployed site and two networks, so it is still to do. Notes:

- `peer.ts` is split into `transport/rtc.ts` (DataChannel adapter), `transport/peer.ts` (offer/answer dance),
  `signaling/envelope.ts` (PROTOCOL §3) and `session/link-session.ts` (one connection attempt end to end).
- The Nostr adapter speaks NIP-01 directly and uses `@noble/curves` for the signatures. It's a lazy chunk (13 KB gzipped).
- Not done yet: the browser and OS hint and the verification words on the Approve screen. They move to phase 4.

## Phase 4: Robustness and reach

- `signaling/manual` (QR / paste, compressed SDP) and `signaling/mqtt`, with automatic fallback across adapters.
- Settings for relay lists, STUN and TURN. Clear diagnosis when the connection fails ("needs TURN").
- Progress, speed, ETA, cancel on both sides, and wake lock during transfers.
- WebKit in the e2e matrix.

## Phase 5: Short codes

- CPace over ristretto255 (`@noble/curves`), a word list, and code entry UI with autocomplete.
- Test vectors from the CPace draft.

## Phase 6: Resume, many receivers, PWA

- Resume from ACK offsets after a reconnect.
- One-to-many: the sender keeps N peer connections, each with its own session keys (default cap 5).
- `vite-plugin-pwa`: installable and offline-capable shell. Share Target API ("Share to e2e-transfer").
- i18n and an a11y audit.

## Later / ideas

- Forward secrecy against a leaked link (ephemeral ECDH inside the channel).
- Optional BLAKE3 digest shown to users.
- CLI or native peer that speaks the same protocol.
- Self-hostable tiny signaling relay as an extra adapter.
