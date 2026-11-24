<script lang="ts">
  import MonitorSmartphone from '@lucide/svelte/icons/monitor-smartphone';
  import { i18n } from '../../lib/i18n/index.svelte.ts';
  import { Button, Card } from '../../lib/ui/index.ts';

  interface Props {
    summary: string;
    onsend: () => void;
    ondecline: () => void;
  }

  let { summary, onsend, ondecline }: Props = $props();

  const m = $derived(i18n.m);
</script>

<Card class="flex flex-col gap-5" aria-labelledby="approve-title">
  <div class="flex items-start gap-3">
    <span class="inline-flex size-11 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">
      <MonitorSmartphone class="size-6" aria-hidden="true" />
    </span>
    <div>
      <h2 id="approve-title" class="text-xl font-semibold">{m.approve.title}</h2>
      <p class="mt-1">{m.approve.body(summary)}</p>
      <p class="mt-1 text-sm text-muted">{m.approve.hint}</p>
    </div>
  </div>
  <div class="flex flex-wrap gap-2">
    <Button size="lg" class="flex-1" onclick={onsend}>{m.approve.send}</Button>
    <Button size="lg" variant="secondary" class="flex-1" onclick={ondecline}>{m.approve.decline}</Button>
  </div>
</Card>
