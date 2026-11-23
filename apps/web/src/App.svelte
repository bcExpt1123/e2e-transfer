<script lang="ts">
  import CircleHelp from '@lucide/svelte/icons/circle-help';
  import Settings from '@lucide/svelte/icons/settings';
  import { Toaster } from 'svelte-sonner';
  import AboutDialog from './features/about/AboutDialog.svelte';
  import ReceiveView from './features/receive/ReceiveView.svelte';
  import SendView from './features/send/SendView.svelte';
  import SettingsDialog from './features/settings/SettingsDialog.svelte';
  import { i18n } from './lib/i18n/index.svelte.ts';
  import { theme } from './lib/theme.svelte.ts';
  import { AppHeader, Button } from './lib/ui/index.ts';

  const m = $derived(i18n.m);

  // Single page, no router (ADR 0005): a `#v1.` fragment means "receive".
  let hash = $state(location.hash);
  const mode = $derived(hash.startsWith('#v1.') ? 'receive' : 'send');

  let settingsOpen = $state(false);
  let aboutOpen = $state(false);

  const toasterTheme = $derived(theme.pref);
</script>

<svelte:window onhashchange={() => (hash = location.hash)} />

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
      <h1 class="mb-6 text-center text-2xl font-semibold text-balance sm:text-[1.75rem]">{m.tagline}</h1>
      <SendView />
    {:else}
      <ReceiveView />
    {/if}
  </main>

  <footer class="py-6 text-center text-xs text-muted">{m.footer}</footer>
</div>

<SettingsDialog bind:open={settingsOpen} />
<AboutDialog bind:open={aboutOpen} />
<Toaster position="bottom-center" theme={toasterTheme} closeButton={false} />
