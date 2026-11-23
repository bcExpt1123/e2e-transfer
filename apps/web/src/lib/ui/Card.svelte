<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { ClassValue, HTMLAttributes } from 'svelte/elements';

  interface Props extends Omit<HTMLAttributes<HTMLElement>, 'class'> {
    class?: ClassValue;
    children: Snippet;
  }

  let { class: className, children, ...rest }: Props = $props();
</script>

<section class={['rounded-lg border border-border bg-surface p-5 shadow-md sm:p-6', className]} {...rest}>
  {@render children()}
</section>
