<script lang="ts">
  import X from '@lucide/svelte/icons/x';
  import { Dialog } from 'bits-ui';
  import type { Snippet } from 'svelte';

  interface Props {
    open?: boolean;
    title: string;
    description?: string;
    closeLabel: string;
    children: Snippet;
  }

  let { open = $bindable(false), title, description, closeLabel, children }: Props = $props();
</script>

<Dialog.Root bind:open>
  <Dialog.Portal>
    <Dialog.Overlay class="fixed inset-0 z-40 bg-overlay" />
    <Dialog.Content
      class="fixed top-1/2 left-1/2 z-50 max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-border bg-surface p-6 shadow-lg"
    >
      <div class="flex items-start justify-between gap-4">
        <Dialog.Title class="text-xl font-semibold">{title}</Dialog.Title>
        <Dialog.Close
          class="-m-2 inline-flex size-11 cursor-pointer items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-text"
          aria-label={closeLabel}
        >
          <X class="size-5" aria-hidden="true" />
        </Dialog.Close>
      </div>
      {#if description}
        <Dialog.Description class="mt-1 text-sm text-muted">{description}</Dialog.Description>
      {/if}
      <div class="mt-5">
        {@render children()}
      </div>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
