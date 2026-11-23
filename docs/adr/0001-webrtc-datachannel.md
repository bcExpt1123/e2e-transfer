# ADR 0001: WebRTC DataChannel as the transport

**Status:** accepted

## Context
Browsers can't open raw sockets. A browser-to-browser byte stream with no server in the data path leaves only WebRTC.
WebTransport and WebSockets both need a server.

## Decision
Use the native `RTCPeerConnection` and a single ordered, reliable `RTCDataChannel`. Don't use a wrapper library (simple-peer, PeerJS), because
we need direct control of `bufferedAmount` backpressure, ICE configuration and failure diagnosis, and the wrappers add size and lag behind the specs.

## Consequences
- We need signaling (ADR 0003) and, for some networks, TURN.
- We keep frames ≤ 64 KiB for cross-browser interoperability.
- One channel keeps ordering simple. Parallel channels may be tested later for throughput.
