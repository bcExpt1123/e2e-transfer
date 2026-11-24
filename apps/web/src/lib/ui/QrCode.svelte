<script lang="ts">
  interface Props {
    value: string;
    label: string;
  }

  let { value, label }: Props = $props();

  let svg = $state('');

  $effect(() => {
    const text = value;
    let stale = false;
    // Loaded on demand: most sessions never show a QR code.
    void import('uqr').then(({ renderSVG }) => {
      if (!stale)
        svg = renderSVG(text, { ecc: 'L', border: 2, whiteColor: '#ffffff', blackColor: '#000000' });
    });
    return () => {
      stale = true;
    };
  });
</script>

<!-- Always dark-on-white, whatever the theme: scanners need the contrast. -->
<div
  class="mx-auto aspect-square w-full max-w-72 overflow-hidden rounded-md bg-white p-1 [&>svg]:h-full [&>svg]:w-full"
  role="img"
  aria-label={label}
>
  {#if svg}
    <!-- uqr only emits <svg>/<path> for the modules; no user markup is involved. -->
    {@html svg}
  {/if}
</div>
