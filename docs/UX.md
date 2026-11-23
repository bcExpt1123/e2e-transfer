# UX & UI specification

## Principles

1. **One obvious action per screen.** Drop a file and get a link. Open the link and click Accept. Nothing else is required.
2. **Always say what is happening and what to do next.** No silent spinners. Every wait state names the step, and every error offers a next action.
3. **Make security visible but quiet.** Show a lock badge and "End-to-end encrypted". Put the details one tap away, not in a wall of text.
4. **Never lose work.** Warn before closing a tab during a transfer. Keep the screen awake. Make resume automatic (phase 6).
5. **Fast and light.** The app is interactive in under a second on mid-range phones. It's usable offline once installed.
6. **Accessible by default.** Meets WCAG 2.2 AA, works fully by keyboard, and announces progress to screen readers.

## Information architecture

There is a single page and no router. The view comes from app state:

```
            ┌───────────── URL has #v1.<secret>? ─────────────┐
            │ no                                               │ yes
        SEND flow                                         RECEIVE flow
  Pick ─► Share ─► Approve ─► Transfer ─► Done      Connect ─► Review ─► Transfer ─► Done
```
Settings (relays, STUN/TURN, theme, language) and "How it works" open as dialogs from the header.

## Screens

### Send: Pick

```
┌──────────────────────────────────────────────┐
│  ◆ e2e-transfer                    ⚙  ?      │
│                                              │
│   ┌──────────────────────────────────────┐   │
│   │        ⬆  Drop files or a folder      │   │
│   │     or  [ Choose files ]  [ Folder ]  │   │
│   └──────────────────────────────────────┘   │
│   🔒 Files go directly to the other device,  │
│      end-to-end encrypted. Nothing uploaded. │
└──────────────────────────────────────────────┘
```

- Accepts drag-and-drop, the file picker, the folder picker, pasting files from the clipboard, and the PWA Share Target.
- After picking, shows a file list (name, size, remove ✕) with the total. The primary button is **Create link**.

### Send: Share (waiting for the receiver)

```
│  3 files · 1.2 GB                            │
│  ┌──────────────────────────────┐  ┌──────┐  │
│  │ https://…/#v1.k3J…  [Copy]   │  │ ▣ QR │  │
│  └──────────────────────────────┘  └──────┘  │
│  [ Share… ]   (Web Share API, mobile)        │
│  ● Waiting for the receiver to open the link │
│  Keep this tab open.                         │
```

- **Copy** gives instant feedback ("Copied ✓"). On mobile, the native share sheet is primary.
- A live status stepper: `Waiting for receiver → Connecting → Secured`.

### Send: Approve

A card reads: "A device opened your link. Send 3 files to it?". It shows the browser and OS from the receiver's HELLO hint, plus optional
verification words (`apple · river · tango · seven`) that both screens display. Buttons: **Send** / **Decline**.

### Receive: Review

```
│  🔒 Secure connection established            │
│  Incoming: 3 files · 1.2 GB                  │
│   ▸ photos/ (2)                     900 MB   │
│     report.pdf                      300 MB   │
│  Save to: [ Choose folder ▾ ]  (when supported)│
│  [ Accept & download ]   [ Decline ]         │
```

### Transfer (both sides)

- An overall progress bar plus per-file rows. Speed (smoothed), ETA, and **Cancel** with confirmation.
- The tab title shows progress (`42% · e2e-transfer`). Progress is also announced through `aria-live="polite"` every 10%.

### Done

- Sender: "Delivered ✓". Actions: **Send more files** and **New link**.
- Receiver: "Saved ✓". Actions: **Open** (where the sink supports it), **Show in folder**, and **Receive another**.

## Connection states and microcopy

| Internal state      | User-facing text                                                |
| ------------------- | --------------------------------------------------------------- |
| joining / signaling | "Waiting for the other device…"                                 |
| connecting          | "Connecting directly…"                                          |
| handshaking         | "Securing connection…"                                          |
| awaiting-accept     | "Waiting for the receiver to accept…" / "Review incoming files" |
| transferring        | "Sending 2 of 3 · 34 MB/s · about 20 s left"                    |
| done                | "Delivered" / "Saved"                                           |

Tone: plain, short and calm. Say "the other device", not "peer". Say "connection", not "ICE".

## Error catalog

Core emits typed `ErrorCode`s, and `apps/web/src/lib/errors.ts` is the **only** place that maps codes to text and actions.

| Code                    | Message                                          | Primary action                        |
| ----------------------- | ------------------------------------------------ | ------------------------------------- |
| `SIGNALING_UNREACHABLE` | "Can't reach the matchmaking network."           | Retry · Use QR instead                |
| `PEER_TIMEOUT`          | "The other device hasn't connected yet."         | Keep waiting · Copy link again        |
| `ICE_FAILED`            | "Your networks block direct connections."        | Configure a relay (TURN) · Learn more |
| `LINK_INVALID`          | "This link is incomplete or damaged."            | Ask the sender for a new link         |
| `DECLINED`              | "The other device declined."                     | Start over                            |
| `PROTOCOL_ERROR`        | "The transfer was interrupted for safety."       | Try again                             |
| `STORAGE_QUOTA`         | "Not enough space to save these files."          | Choose another folder                 |
| `CANCELLED`             | "Transfer cancelled."                            | Start over                            |
| `VERSION_MISMATCH`      | "The other device uses an incompatible version." | Reload the page                       |

## Visual design

- **Design tokens** are CSS custom properties, defined once in `apps/web/src/lib/ui/tokens.css` and exposed to Tailwind through `@theme`:
  color (semantic: `bg`, `surface`, `text`, `muted`, `accent`, `success`, `danger`), spacing, radius, shadow, motion durations.
- Light and dark themes follow `prefers-color-scheme`, with a manual override in Settings.
- The system font stack (no web-font download). Type scale 14/16/20/28.
- Motion: 150–250 ms transitions. Turned off under `prefers-reduced-motion`.
- Layout is mobile-first and single-column, max width 560 px, with touch targets ≥ 44 px.

## Accessibility checklist

- All interactive elements are reachable and operable by keyboard, with a visible focus ring.
- Dialogs, menus and tooltips use headless primitives (`bits-ui`) for correct focus trapping and ARIA.
- The drop zone is also a real `<button>`.
- Contrast is ≥ 4.5:1 for text and ≥ 3:1 for UI. This is enforced by automated axe checks in Playwright.
- Status changes are announced through a single `aria-live` region.

## Performance budgets (enforced in CI)

| Metric                                   | Budget                                             |
| ---------------------------------------- | -------------------------------------------------- |
| Initial JS (gzipped)                     | ≤ 90 KB. QR scanner, MQTT and PAKE are lazy-loaded |
| Initial CSS (gzipped)                    | ≤ 15 KB                                            |
| LCP (Moto G-class, 4G)                   | ≤ 1.5 s                                            |
| Main-thread long tasks during a transfer | none > 50 ms                                       |
