<script lang="ts">
  import Monitor from '@lucide/svelte/icons/monitor';
  import Moon from '@lucide/svelte/icons/moon';
  import Sun from '@lucide/svelte/icons/sun';
  import { i18n, type Locale, locales } from '../../lib/i18n/index.svelte.ts';
  import { type ThemePref, theme } from '../../lib/theme.svelte.ts';
  import { Dialog } from '../../lib/ui/index.ts';
  import NetworkSettings from './NetworkSettings.svelte';

  let { open = $bindable(false) }: { open?: boolean } = $props();

  const m = $derived(i18n.m);
  const themes = $derived([
    { id: 'system' as ThemePref, label: m.settings.themeSystem, icon: Monitor },
    { id: 'light' as ThemePref, label: m.settings.themeLight, icon: Sun },
    { id: 'dark' as ThemePref, label: m.settings.themeDark, icon: Moon },
  ]);
</script>

<Dialog bind:open title={m.settings.title} description={m.settings.description} closeLabel={m.common.close}>
  <div class="flex flex-col gap-6">
    <fieldset>
      <legend class="mb-2 text-sm font-medium">{m.settings.theme}</legend>
      <div class="grid grid-cols-3 gap-2">
        {#each themes as t (t.id)}
          <label
            class="flex cursor-pointer flex-col items-center gap-1 rounded-md border border-border p-3 text-sm has-checked:border-accent has-checked:bg-accent-soft has-focus-visible:outline-2 has-focus-visible:outline-focus"
          >
            <input
              type="radio"
              name="theme"
              value={t.id}
              class="sr-only"
              checked={theme.pref === t.id}
              onchange={() => (theme.pref = t.id)}
            />
            <t.icon class="size-5" aria-hidden="true" />
            {t.label}
          </label>
        {/each}
      </div>
    </fieldset>

    <label class="flex flex-col gap-2 text-sm font-medium">
      {m.settings.language}
      <select
        class="h-11 rounded-md border border-border bg-surface px-3 font-normal"
        value={i18n.locale}
        onchange={(e) => (i18n.locale = e.currentTarget.value as Locale)}
      >
        {#each locales as l (l.id)}
          <option value={l.id}>{l.label}</option>
        {/each}
      </select>
    </label>

    <section class="flex flex-col gap-3 border-t border-border pt-5">
      <h3 class="font-semibold">{m.settings.network}</h3>
      {#if open}
        <NetworkSettings />
      {/if}
    </section>
  </div>
</Dialog>
