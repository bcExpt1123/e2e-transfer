<script lang="ts">
  import Check from '@lucide/svelte/icons/check';
  import Copy from '@lucide/svelte/icons/copy';
  import Button from './Button.svelte';

  interface Props {
    value: string;
    label: string;
    copyLabel: string;
    copiedLabel: string;
    /** Called with false when the clipboard is unavailable, so the caller can explain. */
    oncopy?: (ok: boolean) => void;
  }

  let { value, label, copyLabel, copiedLabel, oncopy }: Props = $props();

  let copied = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let input = $state<HTMLInputElement>();

  async function copy() {
    let ok = true;
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      ok = false;
      input?.select();
    }
    oncopy?.(ok);
    if (!ok) return;
    copied = true;
    clearTimeout(timer);
    timer = setTimeout(() => (copied = false), 2000);
  }
</script>

<div class="flex gap-2">
  <input
    bind:this={input}
    class="h-11 min-w-0 flex-1 truncate rounded-md border border-border bg-surface-2 px-3 font-mono text-sm"
    readonly
    {value}
    aria-label={label}
    onfocus={(e) => e.currentTarget.select()}
  />
  <Button onclick={copy} aria-live="polite">
    {#if copied}
      <Check class="size-4" aria-hidden="true" />
      {copiedLabel}
    {:else}
      <Copy class="size-4" aria-hidden="true" />
      {copyLabel}
    {/if}
  </Button>
</div>
