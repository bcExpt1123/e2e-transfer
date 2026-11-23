<script lang="ts">
  import FileIcon from '@lucide/svelte/icons/file';
  import X from '@lucide/svelte/icons/x';
  import { formatBytes } from '../format.ts';

  interface Item {
    path: string;
    size: number;
  }

  interface Props {
    items: readonly Item[];
    label: string;
    /** When provided, each row gets a remove button. */
    onremove?: (index: number) => void;
    removeLabel?: (path: string) => string;
  }

  let { items, label, onremove, removeLabel = (p) => `Remove ${p}` }: Props = $props();
</script>

<ul class="divide-y divide-border overflow-hidden rounded-md border border-border" aria-label={label}>
  {#each items as item, i (item.path)}
    <li class="flex min-h-12 items-center gap-3 px-3 py-2">
      <FileIcon class="size-5 shrink-0 text-muted" aria-hidden="true" />
      <span class="min-w-0 flex-1 truncate text-sm" title={item.path}>{item.path}</span>
      <span class="shrink-0 text-sm text-muted tabular-nums">{formatBytes(item.size)}</span>
      {#if onremove}
        <button
          type="button"
          class="-mr-1 inline-flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-text"
          aria-label={removeLabel(item.path)}
          onclick={() => onremove(i)}
        >
          <X class="size-4" aria-hidden="true" />
        </button>
      {/if}
    </li>
  {/each}
</ul>
