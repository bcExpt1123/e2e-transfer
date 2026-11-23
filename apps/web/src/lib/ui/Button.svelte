<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { ClassValue, HTMLButtonAttributes } from 'svelte/elements';

  type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
  type Size = 'md' | 'lg' | 'icon';

  interface Props extends Omit<HTMLButtonAttributes, 'class'> {
    variant?: Variant;
    size?: Size;
    class?: ClassValue;
    children: Snippet;
  }

  let {
    variant = 'primary',
    size = 'md',
    class: className,
    type = 'button',
    children,
    ...rest
  }: Props = $props();

  const variants: Record<Variant, string> = {
    primary: 'bg-accent text-accent-fg hover:bg-accent-hover',
    secondary: 'border border-border bg-surface text-text hover:bg-surface-2',
    ghost: 'text-muted hover:bg-surface-2 hover:text-text',
    danger: 'border border-border bg-surface text-danger hover:bg-surface-2',
  };

  const sizes: Record<Size, string> = {
    md: 'h-11 px-4 text-sm',
    lg: 'h-12 px-6 text-base',
    icon: 'size-11',
  };
</script>

<button
  {type}
  class={[
    'inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 rounded-md font-medium transition-colors',
    'disabled:pointer-events-none disabled:opacity-50',
    variants[variant],
    sizes[size],
    className,
  ]}
  {...rest}
>
  {@render children()}
</button>
