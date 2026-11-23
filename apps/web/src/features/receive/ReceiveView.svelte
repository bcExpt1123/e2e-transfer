<script lang="ts">
  import { i18n } from '../../lib/i18n/index.svelte.ts';
  import { Card, StatusStepper } from '../../lib/ui/index.ts';

  const m = $derived(i18n.m);
</script>

<Card class="flex flex-col gap-5">
  <h1 class="text-xl font-semibold">{m.receive.title}</h1>
  <StatusStepper
    steps={[m.status.waiting, m.status.connecting, m.status.secured]}
    current={0}
    label={m.receive.title}
  />
  <p class="text-sm text-muted">{m.receive.preview}</p>
</Card>
