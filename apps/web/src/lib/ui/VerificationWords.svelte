<script lang="ts">
  interface Props {
    words: readonly string[];
    label: string;
  }

  let { words, label }: Props = $props();
</script>

<div class="flex flex-col gap-2">
  <p class="text-sm text-muted">{label}</p>
  <ol class="flex flex-wrap gap-2" aria-label={label} data-testid="verification-words">
    {#each words as word, i (i)}
      <li class="rounded-md bg-surface-2 px-3 py-1.5 font-mono text-base font-semibold">{word}</li>
    {/each}
  </ol>
</div>
