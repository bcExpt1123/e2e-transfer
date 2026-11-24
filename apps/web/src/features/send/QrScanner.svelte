<script lang="ts">
  import { onMount } from 'svelte';

  interface Props {
    label: string;
    onresult: (text: string) => void;
    onerror: () => void;
  }

  let { label, onresult, onerror }: Props = $props();

  interface Detector {
    detect(source: HTMLVideoElement): Promise<{ rawValue: string }[]>;
  }

  let video = $state<HTMLVideoElement>();

  onMount(() => {
    let stream: MediaStream | undefined;
    let raf = 0;
    let stopped = false;
    (async () => {
      try {
        const Ctor = (globalThis as unknown as { BarcodeDetector: new (o: object) => Detector })
          .BarcodeDetector;
        const detector = new Ctor({ formats: ['qr_code'] });
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        if (stopped || !video) return;
        video.srcObject = stream;
        await video.play();
        const tick = async () => {
          if (stopped || !video) return;
          const [hit] = await detector.detect(video).catch(() => []);
          if (hit?.rawValue) onresult(hit.rawValue);
          else raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
      } catch {
        if (!stopped) onerror();
      }
    })();
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      for (const t of stream?.getTracks() ?? []) t.stop();
    };
  });
</script>

<!-- svelte-ignore a11y_media_has_caption: live camera preview, no audio -->
<video bind:this={video} class="aspect-square w-full max-w-72 self-center rounded-md bg-black object-cover" muted playsinline aria-label={label}></video>
