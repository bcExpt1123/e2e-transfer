<script lang="ts">
  import ShieldCheck from '@lucide/svelte/icons/shield-check';
  import { i18n } from '../../lib/i18n/index.svelte.ts';
  import { Dialog } from '../../lib/ui/index.ts';

  let { open = $bindable(false) }: { open?: boolean } = $props();

  const m = $derived(i18n.m);
</script>

<Dialog bind:open title={m.about.title} closeLabel={m.common.close}>
  <ol class="flex flex-col gap-4">
    {#each m.about.steps as step, i (i)}
      <li class="flex gap-3">
        <span
          class="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-accent-soft text-sm font-semibold text-accent"
          aria-hidden="true">{i + 1}</span
        >
        <span class="pt-0.5 text-sm">{step}</span>
      </li>
    {/each}
  </ol>
  <h3 class="mt-5 text-sm font-semibold">{m.about.turnTitle}</h3>
  <p class="mt-1 text-sm text-muted">{m.about.turn}</p>
  <p class="mt-5 flex gap-2 rounded-md bg-surface-2 p-3 text-sm text-muted">
    <ShieldCheck class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
    {m.about.note}
  </p>
</Dialog>
