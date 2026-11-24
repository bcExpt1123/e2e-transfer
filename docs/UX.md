# UX & UI specification

## Principles

1. **One obvious action per screen.** Drop a file and get a link. Open the link and click Accept. Nothing else is required.
2. **Always say what is happening and what to do next.** No silent spinners. Every wait state names the step, and every error offers a next action.
3. **Make security visible but quiet.** Show a lock badge and "End-to-end encrypted". Put the details one tap away, not in a wall of text.
4. **Never lose work.** Warn before closing a tab during a transfer. Keep the screen awake. Resume automatically after a dropped connection.
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
- **"Let several devices download (up to 5 at a time)"** (relay mode, while nobody is connected). With it on, the
  Share screen stays up and a **Devices** list appears under it: one row per device with its name, status
  ("Connecting…", "Waiting for your approval", "Reconnecting…", "1.2 MB of 4 MB", "Delivered"), a progress bar while
  sending, and ✕ to stop sending to that device. Approval cards appear above the link, one device at a time.
- With it off, a second device that opens the link is told the sender is busy (`LINK_BUSY`).

### Send: Approve

A card reads: "A device opened your link. Send 3 files to it?". It shows the browser and OS the receiver reported
(in its encrypted `join`), plus four verification words (`apple · river · tango · seven`) that the receiver's screen
shows too. Buttons: **Send** / **Decline**. Declining keeps the link open for the right person.

### Send: Connect manually

Offered on the Share screen ("No internet relay? Connect manually") and as the action for `SIGNALING_UNREACHABLE`.
The link now carries the sender's offer and is shown as a QR code. Opening it on the other device shows a reply
code (text and QR) to bring back; the sender pastes it, or scans it where the browser supports `BarcodeDetector`.

### Short codes

- **Sender:** the Share screen offers "Use a short code instead". It shows a large code (`7-guitar-ocean`) to read
  out or copy, and notes each wrong guess ("Someone entered a wrong code (1 of 3 tries)").
- **Receiver:** the home screen has a "Have a code?" field with word autocomplete (a combobox with suggestions). After
  a wrong code, "Try again" returns to the field.

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
- **Lost connection:** the screen stays put. The title becomes "Reconnecting…" with a spinner, and the line under the
  bar reads "12 MB of 40 MB · The connection dropped. It continues where it stopped. Keep both pages open." Nobody
  is asked to approve or accept again. Cancel stays available. After 60 s without a new connection, the usual
  `CONNECTION_LOST` error appears.

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
| reconnecting        | "Reconnecting…" (screen readers hear it once)                   |
| done                | "Delivered" / "Saved"                                           |

Tone: plain, short and calm. Say "the other device", not "peer". Say "connection", not "ICE".

## Error catalog

Core emits typed `ErrorCode`s, and `apps/web/src/lib/errors.ts` is the **only** place that maps codes to text and actions.

| Code                    | Message                                                                         | Primary action                                    |
| ----------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------- |
| `SIGNALING_UNREACHABLE` | "Can't reach the matchmaking network."                                          | Retry · Use QR instead                            |
| `PEER_TIMEOUT`          | "The other device hasn't connected yet."                                        | Keep waiting · Copy link again                    |
| `ICE_FAILED`            | "Your networks block direct connections. A relay server (TURN) is needed."      | Configure a relay (TURN) · Try again · Learn more |
| `CONNECTION_LOST`       | "The connection to the other device was lost." (after resume gave up)           | Try again                                         |
| `LINK_INVALID`          | "This link is incomplete or damaged."                                           | Ask the sender for a new link                     |
| `DECLINED`              | "The other device declined."                                                    | Start over                                        |
| `PROTOCOL_ERROR`        | "The transfer was interrupted for safety."                                      | Try again                                         |
| `STORAGE_QUOTA`         | "Not enough space to save these files."                                         | Choose another folder                             |
| `CANCELLED`             | "Transfer cancelled."                                                           | Start over                                        |
| `VERSION_MISMATCH`      | "The other device uses an incompatible version."                                | Reload the page                                   |
| `CODE_INVALID`          | "That code didn't work. Check it with the sender and try again."                | Try again (back to the code field)                |
| `CODE_ATTEMPTS`         | "Wrong codes were entered too many times, so this code was closed."             | Make a new code                                   |
| `LINK_BUSY`             | "The sender is already sending to another device. Try again when they’re done." | Try again                                         |

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
- Spinners stop under `prefers-reduced-motion`.
- Automated checks in CI: axe (WCAG 2.2 AA tags) on the pick, share, approve, review and several-devices screens,
  in light, dark and German; a keyboard-only test that picks files and creates a link without a mouse.

## Languages

English is built in; other languages load on demand (German ships today). The app follows the browser's language
and remembers a choice made in Settings. Every catalog has to match the English one key for key (a type error
otherwise, plus a unit test).

## Installed app

Installable as a PWA (offline shell, PNG and SVG icons). Once installed, it appears in the OS share sheet: files
shared to it land on the pick screen, ready for **Create link**.

## Performance budgets (enforced in CI)

| Metric                                   | Budget                                                                   |
| ---------------------------------------- | ------------------------------------------------------------------------ |
| Initial JS (gzipped)                     | ≤ 90 KB. QR, MQTT, Nostr, PAKE and non-English languages are lazy-loaded |
| Initial CSS (gzipped)                    | ≤ 15 KB                                                                  |
| LCP (Moto G-class, 4G)                   | ≤ 1.5 s                                                                  |
| Main-thread long tasks during a transfer | none > 50 ms                                                             |
