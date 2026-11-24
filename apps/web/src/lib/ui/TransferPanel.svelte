<script lang="ts">
  import LoaderCircle from '@lucide/svelte/icons/loader-circle';
  import Button from './Button.svelte';
  import Progress from './Progress.svelte';

  interface Props {
    title: string;
    /** 0–100, or null while not measurable yet. */
    percent: number | null;
    /** e.g. "12 MB of 40 MB · 34 MB/s · about 20 s left" */
    detail: string;
    progressLabel: string;
    labels: { cancel: string; confirm: string; yes: string; no: string };
    /** Omit to hide the cancel button (e.g. while finishing). */
    oncancel?: (() => void) | undefined;
    /** Paused for a moment (reconnecting): shows a spinner next to the title. */
    busy?: boolean;
  }

  let { title, percent, detail, progressLabel, labels, oncancel, busy = false }: Props = $props();

  let confirming = $state(false);
</script>

<div class="flex flex-col gap-4">
  <div class="flex items-baseline justify-between gap-4">
    <h2 class="flex items-center gap-2 text-lg font-semibold">
      {#if busy}<LoaderCircle class="size-5 animate-spin text-muted motion-reduce:animate-none" aria-hidden="true" />{/if}
      {title}
    </h2>
    {#if percent !== null}
      <span class="text-2xl font-semibold tabular-nums">{percent}%</span>
    {/if}
  </div>
  <Progress value={percent} label={progressLabel} />
  <p class="text-sm text-muted tabular-nums">{detail}</p>

  {#if oncancel}
    {#if confirming}
      <div class="flex flex-wrap items-center gap-2 rounded-md bg-surface-2 p-3" role="group" aria-label={labels.confirm}>
        <span class="flex-1 text-sm font-medium">{labels.confirm}</span>
        <Button variant="danger" onclick={oncancel}>{labels.yes}</Button>
        <Button variant="secondary" onclick={() => (confirming = false)}>{labels.no}</Button>
      </div>
    {:else}
      <Button variant="ghost" class="self-start" onclick={() => (confirming = true)}>{labels.cancel}</Button>
    {/if}
  {/if}
</div>
