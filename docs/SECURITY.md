# Security model

## Assets

File contents, file names and sizes, and who is talking to whom.

## Parties and what each can see

| Party                          | Sees                                                                                  | Can't                                                                                             |
| ------------------------------ | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Static host / CDN              | Page requests (IP, user agent)                                                        | Read the `#fragment`, the files or signaling. See _Malicious app code_ below                      |
| Signaling relays (Nostr, MQTT) | IPs, timing, a random-looking topic, ciphertext sizes, a throwaway Nostr key per join | Decrypt SDP, impersonate a peer, or MITM DTLS (envelopes are AEAD-authenticated with `signalKey`) |
| STUN                           | Your public IP                                                                        | Anything else                                                                                     |
| TURN (if used)                 | Both IPs, traffic volume                                                              | Decrypt (DTLS + app-layer AES-GCM)                                                                |
| Network observer               | Both IPs (once connected peer to peer), traffic volume and timing                     | Contents                                                                                          |
| Anyone holding the link        | **Everything the receiver gets**                                                      |                                                                                                   |

## Guarantees

1. **Confidentiality and integrity** of file contents and metadata against everyone who doesn't hold `S`.
2. **Peer authentication**: the DataChannel endpoint holds `S`, because DTLS fingerprints are exchanged inside the `S`-authenticated envelope.
3. **Exact delivery**: per-frame AEAD with strict counters rejects tampering, reordering, replay, truncation and duplication.
4. **Fresh keys per session**: frame keys mix random nonces from both peers, so a resumed session never reuses a nonce.

5. **Leaked-link check**: the sender approves each device after a verified handshake, seeing four verification
   words that match the receiver's screen only within that session. The device hint ("Firefox on Android") is
   self-reported and only a convenience.

6. **Short codes**: CPace gives an attacker one online guess per attempt and nothing to test offline. Each code
   allows 3 attempts, which the sender sees, and is then closed. The probability of success is ≈ 7 · 10⁻⁷ per code.

7. **Resume can't be hijacked**: a resumed session is keyed by a ticket that only the two ends of the interrupted
   session derived (PROTOCOL §4.6). Holding the link isn't enough to step into a reconnecting transfer, and a
   resumed session needs no new approval because it proves it is the device approved before.

8. **Several receivers are separate**: each device gets its own connection, session keys and verification words,
   and is approved on its own. One receiver learns nothing about the others' sessions.

## Explicit non-guarantees

- **The link is a bearer credential.** Leaking it (chat history, screenshots, link previews that fetch only the
  path, not the fragment) lets someone else connect. Mitigations: the sender must confirm the receiver before sending
  `MANIFEST`; links work for a single receiver unless the sender turns on "several devices" (each still approved one
  by one); sessions expire when the sender's tab closes; and short codes avoid long-lived links altogether.
- **Link holders can disrupt.** Anyone with the link can read the signaling envelope, so they can occupy the
  sender's only slot (others then get `LINK_BUSY`), or replay a receiver's resume `join` to make the sender drop a
  live connection, which then resumes. They can't read or alter any data. This is denial of service only.
- **No forward secrecy against a stolen link.** Anyone with `S` and a recording of the signaling can derive session
  keys. If this matters, a future version can add an ephemeral ECDH inside the DataChannel (tracked in the roadmap).
- **Signaling metadata.** Nostr relays can link the sender and receiver of one transfer (same topic, close in
  time). They can't link two transfers to each other: topics are derived from fresh secrets and each join uses a new key.
- **IP addresses are revealed** to the peer and to relays. Users who need IP privacy should force relay-only ICE (TURN) or use a VPN or Tor.
- **Malicious app code.** A compromised host could serve JavaScript that steals the key. Mitigations: a strict CSP, Subresource Integrity on any external script (none planned), reproducible builds, release hashes published in the repo, and the ability to self-host or install as a PWA. This is the same limit every web-based E2E tool has.
- **Endpoint compromise** (malware, malicious extensions) is out of scope.
- **Shared files stay local.** Files shared to the installed app from the OS share sheet are parked in the
  service worker's cache on the device only until the page takes them, then deleted.

## Implementation rules

- Use WebCrypto for all symmetric crypto and HKDF. Use `crypto.getRandomValues` for all randomness. Never use `Math.random`.
- Treat keys as non-extractable `CryptoKey` objects wherever possible. Don't log keys, the secret or SDP.
- Strip the fragment from the URL immediately after reading it (`history.replaceState`).
- Validate and sanitize every field in the MANIFEST: path rules (PROTOCOL §4.3), size bounds and file count.
- Any protocol violation is fatal and closes the session. Never "try to continue".
- CSP: `default-src 'self'; connect-src 'self' wss: stun: turn:; img-src 'self' blob: data:; object-src 'none'; base-uri 'none'`.
  The `wss:` source can be narrowed to the configured relay list at build time.
- No analytics or third-party scripts.
- Pin dependencies, use a lockfile, run Dependabot and require review for any crypto-related dependency bump.

## Reporting

Report vulnerabilities privately via GitHub Security Advisories on this repository.
