# Protocol v1

All integers are unsigned big-endian. `‖` means concatenation. `HKDF` is HKDF-SHA-256 (RFC 5869).
Strings are UTF-8. `b64u` is base64url without padding.

## 1. Shared secret

| Mode                | How the secret `S` (32 bytes) is established                  |
| ------------------- | ------------------------------------------------------------- |
| Link (phase 3, MVP) | Sender: `S = random(32)`. Link: `https://<app>/#v1.<b64u(S)>` |
| Code (phase 5)      | Code `N-word-word`. Both sides run CPace (see §6); `S = ISK`  |

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
```

`nonceS` and `nonceR` are fresh 16-byte random values sent by each side in `HELLO`. Every connection attempt,
including a resume, therefore gets new frame keys, and counters can safely restart at 0.

## 3. Signaling envelope

Each signaling message, on any adapter, is:

```
envelope   = iv(12, random) ‖ AES-GCM(signalKey, iv, plaintext, aad = "sig/v1")
plaintext  = JSON { "from": b64u(8 random bytes, per tab), "seq": n, "ts": unix_ms, "t": type, "d": data }
```

| `t`      | Sender of message | `d`                                               |
| -------- | ----------------- | ------------------------------------------------- |
| `join`   | receiver          | `{}`                                              |
| `offer`  | sender            | `{ sdp }`                                         |
| `answer` | receiver          | `{ sdp }`                                         |
| `ice`    | both              | `{ candidate }` (trickle; omitted in manual mode) |
| `bye`    | both              | `{ reason? }`                                     |
| `pake`   | both (phase 5)    | `{ msg }`                                         |

Receivers drop messages that fail to decrypt, come from themselves, repeat a `(from, seq)` pair already seen, or have `|now − ts| > 120 s`.
Because SDP travels inside this authenticated envelope, the DTLS fingerprints are bound to `S`. Someone without the secret can't
intercept the DataChannel.

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

### 4.5 Integrity

AEAD per frame, strict counters and the `FILE_END` size check together guarantee that the receiver gets exactly the bytes the sender sent, in order and
complete. A whole-file hash is therefore **not** required. An optional BLAKE3 digest (via `hash-wasm`) may be added later as a
`FILE_END` extension, purely for user-visible verification.

### 4.6 Resume (phase 6)

After a disconnect, the peers repeat signaling and HELLO, which produces new keys. The receiver sends `ACCEPT.resume` with its last acknowledged offsets, and the sender
continues from those offsets.

## 5. Limits and defaults

| Parameter                 | Default         |
| ------------------------- | --------------- |
| chunkSize (plaintext)     | 61 440 (60 KiB) |
| bufferedAmount high / low | 4 MiB / 1 MiB   |
| ACK interval              | 1 MiB           |
| Signaling message max age | 120 s           |
| Max files per manifest    | 10 000          |

## 6. Short codes with CPace (phase 5, draft)

- Code: `N-w1-w2`. `N` is 1–999, and the words come from a 2048-word list (about 22 bits of password entropy).
- Nameplate topic: `hex(HKDF(salt="e2e-transfer/v1/nameplate", IKM=N, "room", 16))`. Collisions with strangers are expected; a peer with a different code simply fails the PAKE.
- CPace (draft-irtf-cfrg-cpace) over ristretto255, with `PRS = code` and `CI = "e2e-transfer/v1"`. Messages travel as `pake` signaling
  messages. Because this happens before `S` is known, these messages use an unauthenticated envelope.
- `S = ISK`, after which everything else proceeds as in link mode. The `signalKey` derived from `S` protects the offer and answer.
- An attacker gets **one online guess per session**, and failed attempts are visible to the user.
