<script lang="ts">
  import CircleHelp from '@lucide/svelte/icons/circle-help';
  import Settings from '@lucide/svelte/icons/settings';
  import { Toaster } from 'svelte-sonner';
  import AboutDialog from './features/about/AboutDialog.svelte';
  import ReceiveView from './features/receive/ReceiveView.svelte';
  import SendView from './features/send/SendView.svelte';
  import SettingsDialog from './features/settings/SettingsDialog.svelte';
  import { i18n } from './lib/i18n/index.svelte.ts';
  import { ScreenWakeLock } from './lib/state/browser.ts';
  import { incoming } from './lib/state/link.svelte.ts';
  import { ReceiveController } from './lib/state/receive.svelte.ts';
  import { SendController } from './lib/state/send.svelte.ts';
  import { theme } from './lib/theme.svelte.ts';
  import { AppHeader, Button } from './lib/ui/index.ts';

  const m = $derived(i18n.m);

  // Single page, no router (ADR 0005): a `#v1.` link means "receive". The secret is
  // taken out of the URL right away and kept in memory only.
  incoming.takeFromLocation();
  const send = new SendController();
  let receive = $state(new ReceiveController());
  const mode = $derived(incoming.status === 'none' ? 'send' : 'receive');

  function onhashchange() {
    // A new link pasted into the address bar of an open tab.
    const before = incoming.status;
    incoming.takeFromLocation();
    if (incoming.status !== 'none' && before !== 'none') {
      receive.cancel();
      receive = new ReceiveController();
    }
  }

  let settingsOpen = $state(false);
  let aboutOpen = $state(false);
  const toasterTheme = $derived(theme.pref);

  // --- Never lose work (docs/UX.md § Principles) ---
  const active = $derived(mode === 'send' ? send : receive);
  const transferring = $derived(active.phase === 'transferring' || active.phase === 'finishing');

  function onbeforeunload(e: BeforeUnloadEvent) {
    if (active.busy) e.preventDefault();
  }

  const wakeLock = new ScreenWakeLock();
  $effect(() => {
    wakeLock.held = active.busy;
  });

  $effect(() => {
    document.title = transferring ? `${active.percent}% · ${m.appName}` : m.appName;
  });

  // Screen readers: one polite announcement per 10% (docs/UX.md § Transfer).
  let announcement = $state('');
  let lastDecile = -1;
  $effect(() => {
    if (!transferring) {
      lastDecile = -1;
      return;
    }
    const decile = Math.floor(active.percent / 10);
    if (decile !== lastDecile) {
      lastDecile = decile;
      announcement = m.transfer.percent(decile * 10);
    }
  });
</script>

<svelte:window {onhashchange} {onbeforeunload} />

<div class="mx-auto flex min-h-dvh max-w-[560px] flex-col px-4">
  <AppHeader title={m.appName}>
    {#snippet actions()}
      <Button variant="ghost" size="icon" aria-label={m.header.about} onclick={() => (aboutOpen = true)}>
        <CircleHelp class="size-5" aria-hidden="true" />
      </Button>
      <Button variant="ghost" size="icon" aria-label={m.header.settings} onclick={() => (settingsOpen = true)}>
        <Settings class="size-5" aria-hidden="true" />
      </Button>
    {/snippet}
  </AppHeader>

  <main class="flex-1 py-4 sm:py-8">
    {#if mode === 'send'}
      {#if send.phase === 'idle'}
        <h1 class="mb-6 text-center text-2xl font-semibold text-balance sm:text-[1.75rem]">{m.tagline}</h1>
      {:else}
        <h1 class="sr-only">{m.appName}</h1>
      {/if}
      <SendView ctrl={send} />
    {:else}
      {#key receive}
        <ReceiveView ctrl={receive} />
      {/key}
    {/if}
  </main>

  <footer class="py-6 text-center text-xs text-muted">{m.footer}</footer>
</div>

<div class="sr-only" aria-live="polite" aria-atomic="true">{announcement}</div>

<SettingsDialog bind:open={settingsOpen} />
<AboutDialog bind:open={aboutOpen} />
<Toaster position="bottom-center" theme={toasterTheme} closeButton={false} />
