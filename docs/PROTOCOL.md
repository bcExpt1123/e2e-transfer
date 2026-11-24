# Protocol v1

All integers are unsigned big-endian. `‖` means concatenation. `HKDF` is HKDF-SHA-256 (RFC 5869).
Strings are UTF-8. `b64u` is base64url without padding.

## 1. Shared secret

| Mode                | How the secret `S` (32 bytes) is established                                   |
| ------------------- | ------------------------------------------------------------------------------ |
| Link (phase 3, MVP) | Sender: `S = random(32)`. Link: `https://<app>/#v1.<b64u(S)>`                  |
| Manual (phase 4)    | Same `S`; the link also carries the offer: `#v1.<b64u(S)>.<offer code>` (§3.1) |
| Code (phase 5)      | Code `N-word-word`. Both sides run CPace (see §6); `S = ISK`                   |

The fragment is read by the page script and then removed from the address bar with `history.replaceState`.

## 2. Key tree

```
PRK         = HKDF-Extract(salt = "e2e-transfer/v1", IKM = S)
roomTopic   = hex(HKDF-Expand(PRK, "room",   16))          // signaling topic, public
signalKey   = HKDF-Expand(PRK, "signal", 32)               // AES-256-GCM, signaling envelope
// after HELLO exchange (§4):
sessionPRK  = HKDF-Extract(salt = nonceS ‖ nonceR, IKM = HKDF-Expand(PRK, "session", 32))
keyS2R      = HKDF-Expand(sessionPRK, "s2r", 32)           // sender → receiver frames
keyR2S      = HKDF-Expand(sessionPRK, "r2s", 32)           // receiver → sender frames
sas         = HKDF-Expand(sessionPRK, "sas", 4)            // 4 verification words, 1 byte each
resumeIkm   = HKDF-Expand(sessionPRK, "resume", 32)        // next session's IKM after a drop (§4.6)
resumeId    = hex(HKDF-Expand(sessionPRK, "resume-id", 8)) // routes the rejoin; reveals nothing about resumeIkm
```

The verification words index a fixed 256-word list (`SAS_WORDS` in `core/src/sas.ts`). Both screens show them
after `HELLO`. They match only between the two ends of one session, so the sender can confirm they are talking
to the intended person and not to someone who obtained a leaked link.

`nonceS` and `nonceR` are fresh 16-byte random values sent by each side in `HELLO`. Every connection attempt,
including a resume, therefore gets new frame keys, and counters can safely restart at 0.

## 3. Signaling envelope

Each signaling message, on any adapter, is:

```
envelope   = iv(12, random) ‖ AES-GCM(signalKey, iv, plaintext, aad = "sig/v1")
plaintext  = JSON { "from": b64u(8 random bytes, per tab), "to"?: id, "seq": n, "ts": unix_ms, "t": type, "d": data }
```

`to` is the recipient's `from` id. It is absent only on `join`, which is a broadcast. Each connection attempt
locks onto one peer (the receiver: the first `offer`) and ignores everyone else. The sender stays in the room for
the whole share and gives each new `join` its own slot with its own connection and session keys, up to
`maxReceivers` at a time (default 1). A `join` beyond that limit gets `bye {reason: "busy"}`, which the receiver
reports as `LINK_BUSY`. A `join` carrying `resume` is routed to the slot that issued that ticket (§4.6); unknown
tickets are ignored.

| `t`      | Sender of message | `d`                                                                                      |
| -------- | ----------------- | ---------------------------------------------------------------------------------------- |
| `join`   | receiver          | `{ hint?, resume? }`: device description (unauthenticated decoration); `resumeId` (§4.6) |
| `offer`  | sender            | `{ sdp }`                                                                                |
| `answer` | receiver          | `{ sdp }`                                                                                |
| `ice`    | both              | `{ candidate }` (trickle; omitted in manual mode)                                        |
| `bye`    | both              | `{ reason? }`: `"cancelled"`, `"busy"` (sender is at its receiver limit), or none        |
| `pake`   | both (phase 5)    | `{ msg }`                                                                                |

Receivers drop messages that fail to decrypt, come from themselves, are addressed to someone else, repeat a `(from, seq)` pair already seen, or have `|now − ts| > 120 s`.

**Connection setup.** The sender always makes the offer. The receiver sends `join` every 2 s until an `offer`
arrives (relays may drop messages). A repeated `join` from the locked peer makes the sender resend its offer, and a
repeated `offer` makes the receiver resend its answer. ICE candidates that arrive before the remote description are
queued, including candidates that overtake the offer on the relays (buffered per author). `bye {reason: "cancelled"}` reports a cancel during setup; any other `bye` counts as a lost connection.
The receiver gives up after 30 s without an offer (`PEER_TIMEOUT`); either side gives up when ICE fails or the channel
isn't open 30 s after setup starts (`ICE_FAILED`). The receiver leaves the signaling room once the DataChannel is open;
the sender stays until the share ends, to hear new receivers and returning ones (§4.6).
Because SDP travels inside this authenticated envelope, the DTLS fingerprints are bound to `S`. Someone without the secret can't
intercept the DataChannel.

### 3.1 Manual connect (no signaling network)

```
offer code = b64u( iv(12) ‖ AES-GCM(signalKey, iv, deflate-raw(SDP offer),  aad = "manual/v1/offer") )
reply code = b64u( iv(12) ‖ AES-GCM(signalKey, iv, deflate-raw(SDP answer), aad = "manual/v1/answer") )
```

ICE is not trickled: each side waits for candidate gathering to complete (at most 3 s) and sends one SDP with
all candidates. The offer code goes into the link (§1). Opening the link produces the reply code, which the
user brings back to the sender (copy and paste, or a QR code where the browser can scan one). A code that fails
to decrypt is refused without ending the session, so the user can paste again. The ICE timeout on the sender
starts only once the reply is applied; the receiver waits without a timeout.

## 4. DataChannel

One channel: `label = "e2e-transfer/v1"`, `ordered = true`, `binaryType = "arraybuffer"`.

### 4.1 HELLO (unencrypted, first message each way)

```
"E2ET" ‖ version u8 (=1) ‖ role u8 (0 = sender, 1 = receiver) ‖ nonce(16)
```

A side that receives an unknown version sends nothing further and closes the channel. After both HELLOs, every message is a frame.

### 4.2 Frame

```
header  = type u8 ‖ flags u8 ‖ reserved u16 (=0) ‖ counter u64        // 12 bytes, also used as AAD
nonce   = 0x00000000 ‖ counter u64                                    // 96-bit GCM nonce
frame   = header ‖ AES-GCM(key = keyS2R | keyR2S by direction, nonce, payload, aad = header)
```

- Each direction keeps its own counter, starting at 0 and incremented by 1 for every frame.
- The receiver of a frame requires `counter == expected`. Any mismatch or authentication failure is fatal: send `ERROR` if possible, then close.
- Maximum frame size is 65 536 bytes.

### 4.3 Frame types

| Type | Name     | Dir      | Payload                                                            |
| ---- | -------- | -------- | ------------------------------------------------------------------ |
| 0x02 | MANIFEST | S→R      | JSON `{ files: [{ path, size, mime, mtime? }], chunkSize, total }` |
| 0x03 | ACCEPT   | R→S      | JSON `{ files: [indices], resume?: { [index]: offset } }`          |
| 0x04 | REJECT   | R→S      | JSON `{ reason? }`                                                 |
| 0x10 | CHUNK    | S→R      | `fileIdx u32 ‖ offset u64 ‖ bytes`                                 |
| 0x11 | FILE_END | S→R      | `fileIdx u32 ‖ size u64`                                           |
| 0x12 | ACK      | R→S      | `fileIdx u32 ‖ offset u64` (bytes durably written)                 |
| 0x20 | DONE     | S→R, R→S | empty                                                              |
| 0x7E | CANCEL   | both     | JSON `{ reason? }`                                                 |
| 0x7F | ERROR    | both     | JSON `{ code, message? }`                                          |

`path` uses `/` separators and is relative. The receiver must reject absolute paths, `..` segments, empty segments,
and control characters before calling any sink.

### 4.4 Flow

```
S                                   R
│── HELLO ─────────────────────────►│
│◄───────────────────────── HELLO ──│        derive keyS2R / keyR2S
│── MANIFEST ──────────────────────►│        user reviews names and sizes
│◄──────────────────────── ACCEPT ──│        (or REJECT)
│── CHUNK … CHUNK ─────────────────►│
│◄─────────────────────────── ACK ──│        every ≥ 1 MiB and at FILE_END
│── FILE_END ──────────────────────►│        receiver checks size == bytes written
│   … next file …                   │
│── DONE ──────────────────────────►│
│◄────────────────────────── DONE ──│        close
```

**Flow control.** A DataChannel has no receive-side backpressure: if the receiver's disk is slower than
the network, incoming frames pile up in its memory. Therefore:

- The receiver MUST send `ACK` at least every `ACK_INTERVAL_MAX` (1 MiB) of data **durably written**, and at every `FILE_END`.
- The sender MUST NOT have more than `maxUnackedBytes` (default 16 MiB, at least 2 MiB) sent but unacknowledged.
- Separately, the sender pauses while its own `bufferedAmount` exceeds the high watermark (§5).

**Ending a session.** `CANCEL` and `ERROR` may be sent by either side at any time and end the session at once.
The receiving side reports the peer's code to the user and does not reply. Closing an `RTCPeerConnection`
discards data still in flight, so **the side that sends the last frame does not close first**: after sending its final
`DONE`, a `REJECT`, a `CANCEL` or an `ERROR`, a peer waits up to `closeGraceMs` (3 s) for the other side to close the
channel, then closes it itself. The side that reads such a frame closes immediately. A close with no terminal frame
before it is reported as `CONNECTION_LOST`.

**Sender approval.** After `HELLO`, the sender's user confirms the device before anything about the files is sent.
Declining sends `ERROR {code: "DECLINED"}`.

### 4.5 Integrity

AEAD per frame, strict counters and the `FILE_END` size check together guarantee that the receiver gets exactly the bytes the sender sent, in order and
complete. A whole-file hash is therefore **not** required. An optional BLAKE3 digest (via `hash-wasm`) may be added later as a
`FILE_END` extension, purely for user-visible verification.

### 4.6 Resume

A transfer interrupted by a lost connection (`CONNECTION_LOST` or `ICE_FAILED` after `ACCEPT`) continues on a new
connection without asking either user again.

1. The receiver keeps the partly written file open and rejoins the room with a new signaling id and
   `join {resume: resumeId}` of the interrupted session.
2. The sender routes that `join` to the slot that issued the ticket. If it hasn't noticed the drop yet, it drops the
   old connection now. A new WebRTC connection is set up as in §3.
3. Both sides run HELLO with fresh nonces but use `resumeIkm` instead of the link's session IKM. Only the two ends of
   the previous session know it, so someone else holding the link can't complete this handshake. The sender skips
   the approval step.
4. The sender sends the same MANIFEST; the receiver checks it is identical byte for byte.
5. The receiver answers `ACCEPT {files, resume}`: `files` lists what it still needs, in order, and `resume` maps the
   first, partly written one to the number of bytes it has written. The sender rejects files that weren't in the
   previous `ACCEPT`, and offsets beyond a file's size.
6. The sender continues each listed file from its offset (`CHUNK` offsets and `ACK` values are absolute).

Each resumed session has its own ticket for the next drop. A side switches to the new ticket once `ACCEPT` is sent
(receiver) or received (sender); until then the sender also accepts the previous ticket, so an `ACCEPT` lost in the
drop can't strand the transfer. Either side gives up after `resumeTimeoutMs` without a working connection and reports
the original `CONNECTION_LOST`; the receiver then discards the partial file. A `CANCEL`, `ERROR`, or decline
ends the transfer for good. Resume needs the signaling network, so manual connections (§3.1) don't resume.

Resume works while both pages stay open. Surviving a reload would need the files and partial output to be
persisted, which is out of scope for v1.

## 5. Limits and defaults

| Parameter                 | Default                            |
| ------------------------- | ---------------------------------- |
| chunkSize (plaintext)     | 61 440 (60 KiB)                    |
| bufferedAmount high / low | 4 MiB / 1 MiB                      |
| ACK interval              | 1 MiB (maximum)                    |
| maxUnackedBytes (window)  | 16 MiB                             |
| Signaling message max age | 120 s                              |
| `join` repeat interval    | 2 s                                |
| Peer timeout (receiver)   | 30 s                               |
| Connect timeout (ICE)     | 30 s                               |
| closeGraceMs              | 3 s                                |
| Disconnected → lost       | 8 s                                |
| resumeTimeoutMs           | 60 s                               |
| maxReceivers              | 1 (5 when "several devices" is on) |
| ICE gathering (manual)    | 3 s (maximum)                      |
| Max files per manifest    | 10 000                             |

## 6. Short codes with CPace (phase 5)

- **Code:** `N-w1-w2`. `N` is 1–999 and is public. The two words come from the BIP-39 English list (2048 words), so
  the password has 22 bits of entropy. Every word is unique in its first four letters, so input like `7 guit ocea`
  is accepted. Input is case-insensitive, and spaces, dashes, dots and commas all work as separators.
- **Nameplate:** `topic = hex(HKDF(salt="e2e-transfer/v1/nameplate", IKM=utf8(N), "room", 16))`, and the envelope
  key is `HKDF(…, "signal", 32)`. That key only obfuscates, because `N` is public. Messages use the normal §3
  envelope with type `pake`. Collisions with strangers are expected: a peer with a different code fails the
  key confirmation.
- **PAKE:** CPace per draft-irtf-cfrg-cpace-21, ristretto255 + SHA-512, initiator-responder mode with A = sender
  and B = receiver. `PRS = utf8("N-w1-w2")` in canonical form, `CI = "e2e-transfer/v1"`, `sid = ""` (freshness comes
  from Ya/Yb in the transcript), `ADa = "sender"`, `ADb = "receiver"`. The implementation is checked against the
  draft's §B.3 test vectors.
- **Messages:**

  ```
  R → *  pake {Y: b64u(Yb)}                       repeated every 2 s until answered (30 s timeout)
  S → R  pake {Y: b64u(Ya), tag: b64u(tagS)}
  R → S  pake {tag: b64u(tagR)}                   sent even when tagS fails, so the sender learns at once
  tagS = HMAC-SHA256(ISK, "e2e-transfer/v1/confirm/sender"), tagR likewise with "receiver"
  ```

- **Result:** `S = ISK[0..32]`. Both sides then leave the nameplate and continue exactly as in link mode on
  `roomTopic(S)`. There's no Approve step: knowing the code already identifies the receiver.
- **Online guessing:** each attempt costs an attacker one guess (CPace). The sender counts a wrong or missing
  confirmation, or an identity share, as a failed attempt and shows it. After 3 failures the code is closed
  (`CODE_ATTEMPTS`), and a new code means new words. The chance of guessing one code is about 3 / 4 194 304.
