# ADR 0003: Pluggable signaling over public relays

**Status:** accepted

## Context
WebRTC peers must exchange SDP and ICE before they can connect. We don't want to run a server, but signaling done entirely by hand is clunky.

## Decision
- Define a minimal `Signaling` interface that moves opaque bytes on a topic ([ARCHITECTURE](../ARCHITECTURE.md#adapter-interfaces)).
- Do all encryption, authentication and replay protection in `core`, so adapters are untrusted pipes.
- Default adapter: **Nostr** ephemeral events on several public relays, for redundancy. Alternative: **MQTT** over WSS. Fully serverless fallback:
  **manual** QR or copy-paste.
- We considered Trystero, which offers similar multi-strategy signaling. We rejected it because it owns the RTCPeerConnection, which conflicts with
  ADR 0001, and because we want our own envelope format.

## Consequences
- Public relays can be flaky or rate-limited, so we publish to several and keep the list configurable.
- Adding a self-hosted relay later is a new adapter, with no changes to `core`.
