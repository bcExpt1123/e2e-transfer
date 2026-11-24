<script lang="ts">
  import ShieldCheck from '@lucide/svelte/icons/shield-check';
  import { formatBytes } from '../../lib/format.ts';
  import { i18n } from '../../lib/i18n/index.svelte.ts';
  import type { SaveTarget } from '../../lib/state/receive.svelte.ts';
  import { Button, Card, FileList } from '../../lib/ui/index.ts';

  interface Props {
    files: readonly { path: string; size: number }[];
    total: number;
    canPickFolder: boolean;
    inMemory: boolean;
    onaccept: (target: SaveTarget) => void;
    ondecline: () => void;
  }

  let { files, total, canPickFolder, inMemory, onaccept, ondecline }: Props = $props();

  const m = $derived(i18n.m);
  let target = $state<SaveTarget>('download');
  // Memory-backed downloads get risky well before the browser says so.
  const warnMemory = $derived(inMemory && target === 'download' && total > 256 * 1024 * 1024);
</script>

<Card class="flex flex-col gap-5">
  <p class="flex items-center gap-2 text-sm font-medium text-success">
    <ShieldCheck class="size-4" aria-hidden="true" />
    {m.receive.secured}
  </p>
  <div>
    <h1 class="text-xl font-semibold">{m.receive.reviewTitle}</h1>
    <p class="mt-1 text-sm text-muted">{m.send.summary(files.length, formatBytes(total))}</p>
  </div>
  <FileList items={files} label={m.receive.reviewTitle} />

  {#if canPickFolder}
    <fieldset>
      <legend class="mb-2 text-sm font-medium">{m.receive.saveTo}</legend>
      <div class="grid grid-cols-2 gap-2">
        {#each [{ id: 'download', label: m.receive.saveDownloads }, { id: 'folder', label: m.receive.saveFolder }] as const as opt (opt.id)}
          <label
            class="flex min-h-11 cursor-pointer items-center justify-center rounded-md border border-border p-2 text-center text-sm has-checked:border-accent has-checked:bg-accent-soft has-focus-visible:outline-2 has-focus-visible:outline-focus"
          >
            <input type="radio" name="save-target" value={opt.id} class="sr-only" bind:group={target} />
            {opt.label}
          </label>
        {/each}
      </div>
    </fieldset>
  {/if}

  {#if warnMemory}
    <p class="rounded-md bg-surface-2 p-3 text-sm text-muted">{m.receive.largeInMemory}</p>
  {/if}

  <div class="flex flex-wrap gap-2">
    <Button size="lg" class="flex-1" onclick={() => onaccept(target)}>
      {target === 'folder' ? m.receive.acceptFolder : m.receive.accept}
    </Button>
    <Button size="lg" variant="secondary" class="flex-1" onclick={ondecline}>{m.receive.decline}</Button>
  </div>
</Card>
