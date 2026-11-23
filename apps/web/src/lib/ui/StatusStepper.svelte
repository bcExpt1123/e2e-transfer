<script lang="ts">
  import Check from '@lucide/svelte/icons/check';
  import LoaderCircle from '@lucide/svelte/icons/loader-circle';

  interface Props {
    steps: readonly string[];
    /** Index of the active step; steps.length means all done. */
    current: number;
    label: string;
  }

  let { steps, current, label }: Props = $props();
</script>

<ol class="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4" aria-label={label}>
  {#each steps as step, i (step)}
    {@const state = i < current ? 'done' : i === current ? 'active' : 'todo'}
    <li class="flex items-center gap-2 text-sm" aria-current={state === 'active' ? 'step' : undefined}>
      <span
        class={[
          'inline-flex size-6 items-center justify-center rounded-full border',
          state === 'done' && 'border-success bg-success text-surface',
          state === 'active' && 'border-accent text-accent',
          state === 'todo' && 'border-border text-muted',
        ]}
        aria-hidden="true"
      >
        {#if state === 'done'}
          <Check class="size-4" />
        {:else if state === 'active'}
          <LoaderCircle class="size-4 animate-spin motion-reduce:animate-none" />
        {:else}
          <span class="text-xs">{i + 1}</span>
        {/if}
      </span>
      <span class={state === 'todo' ? 'text-muted' : 'text-text'}>{step}</span>
    </li>
  {/each}
</ol>
