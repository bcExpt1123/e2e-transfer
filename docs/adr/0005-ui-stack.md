# ADR 0005: UI stack and state architecture

**Status:** accepted

## Context
We want a polished, accessible and fast UI that stays easy to change as features grow.

## Decision
- **Svelte 5 (runes) + Vite**, as a single page with **no router**. The view is derived from session state, and the
  receive flow is detected by the `#v1.` fragment. This avoids SPA-fallback configuration on static hosts.
- **Tailwind CSS v4** for styling, driven by **design tokens** in CSS custom properties (`tokens.css`, `@theme`).
- **bits-ui** headless primitives (Dialog, Tooltip, Popover, Progress) for correct accessibility without inheriting someone else's look.
- **@lucide/svelte** icons (tree-shaken), **svelte-sonner** toasts, Svelte's built-in transitions.
- **Paraglide JS** for i18n: compile-time, typed and tree-shaken.
- **State:** one `TransferController` class (`*.svelte.ts`, using `$state`) per session. It subscribes to core events and exposes
  read-only reactive state plus commands (`start`, `accept`, `cancel`). Components never touch core directly.

## Alternatives considered
- React: bigger runtime and more boilerplate for the same result. SvelteKit: its routing and SSR aren't needed for a 1-page static app.
- A full component kit (Skeleton, shadcn-svelte): faster at first, but heavier and harder to restyle. bits-ui is what shadcn-svelte is built on, so we can adopt its patterns selectively.

## Consequences
- UI logic can be tested by unit-testing `TransferController` with a fake core.
- The design system is small and owned by us, so its look stays consistent and is easy to restyle.
