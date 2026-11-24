<script lang="ts">
  import Share2 from '@lucide/svelte/icons/share-2';
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
  import { toast } from 'svelte-sonner';
  import { i18n } from '../../lib/i18n/index.svelte.ts';
  import { connectStep, statusLine } from '../../lib/transfer-text.ts';
  import { Button, Card, CopyField, StatusStepper } from '../../lib/ui/index.ts';

  interface Props {
    link: string;
    phase: string;
    summary: string;
    onstop: () => void;
  }

  let { link, phase, summary, onstop }: Props = $props();

  const m = $derived(i18n.m);
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  async function share() {
    try {
      await navigator.share({ title: m.share.shareTitle, url: link });
    } catch {
      // dismissed
    }
  }
</script>

<Card class="flex flex-col gap-5">
  <div>
    <h2 class="text-xl font-semibold">{m.share.title}</h2>
    <p class="mt-1 text-sm text-muted">{summary}</p>
  </div>

  <CopyField
    value={link}
    label={m.share.linkLabel}
    copyLabel={m.share.copy}
    copiedLabel={m.share.copied}
    oncopy={(ok) => !ok && toast.error(m.share.copyFailed)}
  />
  {#if canShare}
    <Button variant="secondary" class="w-full sm:w-auto sm:self-start" onclick={share}>
      <Share2 class="size-4" aria-hidden="true" />
      {m.share.shareButton}
    </Button>
  {/if}

  <p class="flex gap-2 rounded-md bg-surface-2 p-3 text-sm text-muted">
    <TriangleAlert class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
    {m.share.warning}
  </p>

  <div class="flex flex-col gap-2">
    <StatusStepper
      steps={[m.status.waiting, m.status.connecting, m.status.secured]}
      current={connectStep(phase)}
      label={m.share.title}
    />
    <p class="text-sm text-muted">{statusLine(m, phase, 'sender')} {m.share.keepOpen}</p>
  </div>

  <Button variant="ghost" class="self-start" onclick={onstop}>{m.share.stop}</Button>
</Card>
