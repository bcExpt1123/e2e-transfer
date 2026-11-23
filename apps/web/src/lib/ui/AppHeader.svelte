<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    title: string;
    actions?: Snippet;
  }

  let { title, actions }: Props = $props();
</script>

<header class="flex items-center justify-between gap-4 py-4">
  <a href="./" class="-ml-1 flex items-center gap-2 rounded-md px-1 text-lg font-semibold">
    <img src="favicon.svg" alt="" class="size-7" width="28" height="28" />
    {title}
  </a>
  {#if actions}
    <nav class="flex items-center gap-1">
      {@render actions()}
    </nav>
  {/if}
</header>
