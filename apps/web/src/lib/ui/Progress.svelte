<script lang="ts">
  import { Progress } from 'bits-ui';

  interface Props {
    /** null = indeterminate */
    value: number | null;
    max?: number;
    label: string;
  }

  let { value, max = 100, label }: Props = $props();

  const pct = $derived(value === null ? null : Math.min(100, Math.max(0, (value / max) * 100)));
</script>

<Progress.Root
  {value}
  {max}
  aria-label={label}
  class="relative h-2 w-full overflow-hidden rounded-full bg-surface-2"
>
  <div
    class={[
      'h-full rounded-full bg-accent transition-[width] duration-(--ds-duration-base)',
      pct === null && 'animate-pulse',
    ]}
    style:width={pct === null ? '35%' : `${pct}%`}
  ></div>
</Progress.Root>
