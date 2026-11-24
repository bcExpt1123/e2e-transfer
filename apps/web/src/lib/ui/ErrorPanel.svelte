<script lang="ts">
  import CircleAlert from '@lucide/svelte/icons/circle-alert';
  import Button from './Button.svelte';

  interface Props {
    title: string;
    message: string;
    actions: readonly { id: string; label: string }[];
    onaction: (id: string) => void;
  }

  let { title, message, actions, onaction }: Props = $props();
</script>

<div class="flex flex-col gap-4" role="alert">
  <div class="flex items-start gap-3">
    <CircleAlert class="mt-0.5 size-6 shrink-0 text-danger" aria-hidden="true" />
    <div>
      <h2 class="text-lg font-semibold">{title}</h2>
      <p class="mt-1 text-muted">{message}</p>
    </div>
  </div>
  {#if actions.length > 0}
    <div class="flex flex-wrap gap-2">
      {#each actions as action, i (action.id)}
        <Button variant={i === 0 ? 'primary' : 'secondary'} onclick={() => onaction(action.id)}>
          {action.label}
        </Button>
      {/each}
    </div>
  {/if}
</div>
