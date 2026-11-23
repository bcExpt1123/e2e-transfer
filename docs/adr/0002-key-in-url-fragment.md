# ADR 0002: Secret in the URL fragment for the MVP

**Status:** accepted

## Context

Peers need a shared secret. Options: a key in the link's fragment, a short code with a PAKE, or showing and comparing fingerprints.

## Decision

The MVP (roadmap phase 3) uses a 256-bit random secret in the link fragment (`#v1.<b64u>`). Browsers never send the fragment to servers.
All keys come from this secret through HKDF ([PROTOCOL §2](../PROTOCOL.md#2-key-tree)). Short codes come later (ADR 0004).

## Consequences

- Simple and strong: there is nothing to brute-force.
- The link is a bearer credential. The UI warns the user, and the sender confirms the receiver before sending.
- Links are long, which is awkward to dictate. That's the reason for the short-code mode.
