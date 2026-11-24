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
- GitHub Actions: lint → typecheck → unit → dep-rules → build → size-limit → e2e (+ axe). Preview deploy per PR, `main` → Firebase Hosting ([DEPLOY.md](DEPLOY.md)).

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

## Phase 4: Robustness and reach ✅

- `signaling/manual` (QR / paste, compressed SDP) and `signaling/mqtt`, with automatic fallback across adapters.
- Settings for relay lists, STUN and TURN. Clear diagnosis when the connection fails ("needs TURN").
- Progress, speed, ETA, cancel on both sides, and wake lock during transfers.
- WebKit in the e2e matrix.
- (from phase 3) Approve screen: device hint and verification words.

Status:

- Manual connect is a transport mode (offer in the link, reply code back), not a `Signaling` adapter. Reply QR
  scanning uses `BarcodeDetector` where available (Chromium on Android and macOS); everywhere else it's paste.
- "Automatic fallback" became parallel use of every network (`multiSignaling`), with manual connect offered when
  all of them fail.
- WebKit runs in CI on macOS (Playwright's Linux WebKit has no WebRTC). Not yet confirmed on a real CI run.
- Not done: per-relay health tracking in `localStorage` (ARCHITECTURE § Why this scales). Moves to phase 6.

## Phase 5: Short codes ✅

- CPace over ristretto255 (`@noble/curves`), a word list, and code entry UI with autocomplete.
- Test vectors from the CPace draft.

Status: CPace follows draft-irtf-cfrg-cpace-21 and passes its §B.3 vectors (generator, shares, K, both ISKs, sid
outputs, invalid points). Key confirmation and a 3-attempt limit per code are added on top (PROTOCOL §6). The
word list is BIP-39 English. Code mode is a separate entry point (`@e2e-transfer/core/code`), loaded on demand
(25 KB gzipped).

## Phase 6: Resume, many receivers, PWA ✅

- Resume from ACK offsets after a reconnect.
- One-to-many: the sender keeps N peer connections, each with its own session keys (default cap 5).
- `vite-plugin-pwa`: installable and offline-capable shell. Share Target API ("Share to e2e-transfer").
- i18n and an a11y audit.
- Per-relay health tracking (moved here from phase 4).

Status:

- **Resume:** after a lost connection (or 8 s in `disconnected`) both sides reconnect on their own and continue from
  the receiver's written offset. Nobody is asked again, and the screen shows "Reconnecting…". The new handshake is
  keyed by a ticket from the interrupted session, so a stranger with the link can't step in (PROTOCOL §4.6). It works
  while both pages stay open; resuming after a reload is not covered. Tested with a fake network that drops mid-file
  (twice in one transfer) and in Chromium and Firefox by closing the real `RTCPeerConnection` mid-transfer.
- **Several devices:** an opt-in switch on the Share screen (up to 5 at a time). Each device has its own slot,
  connection, keys, approval and resume. With the switch off, extra devices are told the sender is busy (`LINK_BUSY`).
- **PWA:** offline shell, PNG icons rendered from the SVGs (`apps/web/scripts/render-icons.mjs`), and a Share Target
  (`public/sw-extras.js`). Updates wait until every tab is closed, so they never land mid-transfer.
- **i18n:** German added and loaded on demand; the browser language is followed and the Settings choice is
  remembered. A test checks every catalog matches English key for key.
- **a11y:** axe in light, dark and German and on the several-devices screen; a keyboard-only send flow test;
  "Reconnecting…" announced once; spinners respect reduced motion.
- **Relay health:** relays and brokers that answer fast are tried first; one that failed twice in a row rests for 30
  minutes (never below two per network).
- Not verified: WebKit on the macOS CI runner; Share Target and install on a real Android device; a real network
  switch (Wi-Fi to mobile data) during a transfer, which the closed-connection test only approximates.

## Later / ideas

- Forward secrecy against a leaked link (ephemeral ECDH inside the channel).
- Optional BLAKE3 digest shown to users.
- CLI or native peer that speaks the same protocol.
- Self-hostable tiny signaling relay as an extra adapter.
