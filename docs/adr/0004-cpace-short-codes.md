# ADR 0004: CPace for short human-readable codes

**Status:** proposed (phase 5)

## Context

Users want to dictate or type something short (`7-guitar-orbit`). A low-entropy code can't serve directly as a key, because an
observer could brute-force it offline.

## Decision

Use the balanced PAKE **CPace** (draft-irtf-cfrg-cpace) over ristretto255, implemented with the audited `@noble/curves`.
The code is the password, and the resulting ISK becomes the secret `S` ([PROTOCOL §6](../PROTOCOL.md#6-short-codes-with-cpace-phase-5-draft)).
We chose CPace over SPAKE2 because it is the CFRG-recommended balanced PAKE and needs no fixed M/N constants.

## Consequences

- An attacker gets one online guess per session, so roughly 22 bits of entropy is enough.
- Stranger collisions on the nameplate topic are expected. The PAKE fails cleanly and the UI retries or reports the failure.
- Adds about 30 KB (gzipped) of dependencies, loaded lazily only in code mode.
