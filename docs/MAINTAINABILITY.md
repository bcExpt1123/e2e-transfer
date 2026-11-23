# Maintainability & contribution guide

The aim is that a new contributor can find the right file in a minute and change it without fear.

## Layering (enforced)

```
apps/web/src
├── features/            send/, receive/, settings/: screens + feature components
├── lib/state/           TransferController (*.svelte.ts): the ONLY bridge from core to UI
├── lib/ui/              design system: tokens.css, Button, Card, Progress, Dialog, FileList…
├── lib/errors.ts        ErrorCode → message + action (see UX.md)
└── lib/i18n/            Paraglide messages
packages/core            pure TS; no Svelte, no DOM except injected WebRTC/WebCrypto
packages/signaling       Signaling adapters; depend only on core's types
packages/storage         FileSink adapters; depend only on core's types
```

Rules, checked in CI by `dependency-cruiser`:
1. `core` must not import from `apps/*`, Svelte, or concrete adapters.
2. Adapters must not import each other.
3. `features/*` must not import each other. Shared code lives in `lib/`.
4. Components under `lib/ui` are presentational: props in, events out, no core imports.
5. Each package exposes its public API only through `src/index.ts`. Deep imports are lint errors.

## Code conventions
- TypeScript `strict`, `noUncheckedIndexedAccess`, and no `any`. Use `unknown` and narrow it.
- Errors: core throws or emits `TransferError { code: ErrorCode }`. No string matching on messages.
- Events: core exposes a small typed emitter (`session.on('progress', …)`). The UI never polls.
- Constants (chunk size, thresholds, timeouts) live in `core/src/config.ts` and are overridable per session.
- Keep files short, under about 300 lines, with one concept each. Name them after what they do (`frame-codec.ts`, not `utils.ts`).
- Comments explain *why*. Protocol code links to the relevant section of [PROTOCOL.md](PROTOCOL.md).

## Extension points (how the app grows without rewrites)
| To add… | Do this | No changes in |
|---|---|---|
| A signaling network | Implement `Signaling` and pass the contract test suite | core, UI |
| A storage target | Implement `FileSink` and pass the contract test suite | core, UI |
| A key-exchange mode | Implement `KeyExchange` (link, cpace…) that yields `S` | transport, storage |
| A protocol feature | New frame type or MANIFEST field behind a version or capability flag in HELLO | older clients keep working |
| A language | Add `messages/<lang>.json` | code |
| A screen | Add a folder under `features/` | other features |

## Testing pyramid
- **Unit (Vitest):** most tests, mainly in `core`. Coverage gate: core ≥ 90% lines, adapters ≥ 80%.
- **Contract suites:** `packages/signaling/test/contract.ts` and `packages/storage/test/contract.ts`. Every adapter runs them.
- **Component (Vitest + @testing-library/svelte):** design-system components and feature states.
- **E2E (Playwright):** full send/receive across Chromium, Firefox and WebKit, axe a11y scans, and visual snapshots of key screens.
- A bug fix comes with a test that fails without the fix.

## Tooling and workflow
- `pnpm` workspaces with a pinned Node version (`.nvmrc`) and `packageManager` field.
- Biome for lint and format, run as a pre-commit hook via `lefthook`.
- Conventional Commits, with `release-please` for changelog and version tags.
- Renovate for grouped weekly dependency updates. Crypto and WebRTC-related bumps need manual review.
- CI (GitHub Actions): lint → typecheck → unit → dep-rules → build → size-limit → e2e → deploy preview per PR.
- Architecture decisions are written as ADRs in [adr/](adr/). Copy the newest one as a template.

## Definition of done (every PR)
- [ ] Tests added or updated, CI green
- [ ] No new budget violations (bundle size, a11y)
- [ ] New UI text goes through i18n, and new errors are in the error catalog
- [ ] Docs and ADR updated if the protocol, architecture or a public interface changed
