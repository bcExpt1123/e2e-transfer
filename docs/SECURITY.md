# Security model

## Assets

File contents, file names and sizes, and who is talking to whom.

## Parties and what each can see

| Party                          | Sees                                                              | Can't                                                                                             |
| ------------------------------ | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Static host / CDN              | Page requests (IP, user agent)                                    | Read the `#fragment`, the files or signaling. See _Malicious app code_ below                      |
| Signaling relays (Nostr, MQTT) | IPs, timing, a random-looking topic, ciphertext sizes             | Decrypt SDP, impersonate a peer, or MITM DTLS (envelopes are AEAD-authenticated with `signalKey`) |
| STUN                           | Your public IP                                                    | Anything else                                                                                     |
| TURN (if used)                 | Both IPs, traffic volume                                          | Decrypt (DTLS + app-layer AES-GCM)                                                                |
| Network observer               | Both IPs (once connected peer to peer), traffic volume and timing | Contents                                                                                          |
| Anyone holding the link        | **Everything the receiver gets**                                  |                                                                                                   |

## Guarantees

1. **Confidentiality and integrity** of file contents and metadata against everyone who doesn't hold `S`.
2. **Peer authentication**: the DataChannel endpoint holds `S`, because DTLS fingerprints are exchanged inside the `S`-authenticated envelope.
3. **Exact delivery**: per-frame AEAD with strict counters rejects tampering, reordering, replay, truncation and duplication.
4. **Fresh keys per session**: frame keys mix random nonces from both peers, so a resumed session never reuses a nonce.

## Explicit non-guarantees

- **The link is a bearer credential.** Leaking it (chat history, screenshots, link previews that fetch only the
  path, not the fragment) lets someone else connect. Mitigations: the sender must confirm the receiver before sending `MANIFEST`; links work for a single receiver unless the sender chooses multi-receiver mode; sessions expire when the sender's tab closes; and a short-code mode is planned.
- **No forward secrecy against a stolen link.** Anyone with `S` and a recording of the signaling can derive session
  keys. If this matters, a future version can add an ephemeral ECDH inside the DataChannel (tracked in the roadmap).
- **IP addresses are revealed** to the peer and to relays. Users who need IP privacy should force relay-only ICE (TURN) or use a VPN or Tor.
- **Malicious app code.** A compromised host could serve JavaScript that steals the key. Mitigations: a strict CSP, Subresource Integrity on any external script (none planned), reproducible builds, release hashes published in the repo, and the ability to self-host or install as a PWA. This is the same limit every web-based E2E tool has.
- **Endpoint compromise** (malware, malicious extensions) is out of scope.

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
