<script lang="ts">
  import MonitorSmartphone from '@lucide/svelte/icons/monitor-smartphone';
  import X from '@lucide/svelte/icons/x';
  import { i18n } from '../../lib/i18n/index.svelte.ts';
  import { isTerminalPhase, type ReceiverInfo } from '../../lib/state/send.svelte.ts';
  import { receiverStatus } from '../../lib/transfer-text.ts';
  import { Button, Card, Progress } from '../../lib/ui/index.ts';

  interface Props {
    receivers: readonly ReceiverInfo[];
    oncancel: (key: number) => void;
  }

  let { receivers, oncancel }: Props = $props();

  const m = $derived(i18n.m);
  const percent = (r: ReceiverInfo) =>
    r.progress.total > 0 ? Math.floor((r.progress.acked / r.progress.total) * 100) : 0;
</script>

<Card class="flex flex-col gap-3">
  <h2 class="font-semibold">{m.receivers.title}</h2>
  <ul class="flex flex-col gap-3" aria-label={m.receivers.title}>
    {#each receivers as r (r.key)}
      {@const name = r.hint ?? m.receivers.device(r.key)}
      {@const moving = r.phase === 'transferring' || r.phase === 'finishing' || r.phase === 'reconnecting'}
      <li class="flex items-start gap-3" data-testid="receiver">
        <MonitorSmartphone class="mt-0.5 size-5 shrink-0 text-muted" aria-hidden="true" />
        <div class="flex min-w-0 flex-1 flex-col gap-1">
          <div class="flex items-baseline justify-between gap-2">
            <span class="truncate font-medium">{name}</span>
            {#if moving}<span class="text-sm tabular-nums">{percent(r)}%</span>{/if}
          </div>
          {#if moving}
            <Progress value={percent(r)} label={name} />
          {/if}
          <p
            class="text-sm tabular-nums"
            class:text-muted={r.phase !== 'failed'}
            class:text-success={r.phase === 'done'}
            class:text-danger={r.phase === 'failed'}
          >
            {receiverStatus(m, r)}
          </p>
        </div>
        {#if !isTerminalPhase(r.phase)}
          <Button variant="ghost" size="icon" aria-label={m.receivers.stop(name)} onclick={() => oncancel(r.key)}>
            <X class="size-4" aria-hidden="true" />
          </Button>
        {/if}
      </li>
    {/each}
  </ul>
</Card>
