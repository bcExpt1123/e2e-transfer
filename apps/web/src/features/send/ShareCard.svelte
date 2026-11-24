<script lang="ts">
  import QrCodeIcon from '@lucide/svelte/icons/qr-code';
  import ScanLine from '@lucide/svelte/icons/scan-line';
  import Share2 from '@lucide/svelte/icons/share-2';
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
  import { toast } from 'svelte-sonner';
  import { i18n } from '../../lib/i18n/index.svelte.ts';
  import { connectStep, statusLine } from '../../lib/transfer-text.ts';
  import { Button, Card, CopyField, QrCode, StatusStepper } from '../../lib/ui/index.ts';
  import QrScanner from './QrScanner.svelte';

  interface Props {
    link: string | null;
    phase: string;
    summary: string;
    mode: 'relay' | 'manual' | 'code';
    /** Code mode: the short code and how many wrong guesses were made. */
    code?: string | null;
    wrongCodes?: number;
    maxCodeAttempts?: number;
    onstop: () => void;
    onswitch: (mode: 'relay' | 'manual' | 'code') => void;
    onreply: (code: string) => Promise<boolean>;
  }

  let {
    link,
    phase,
    summary,
    mode,
    code = null,
    wrongCodes = 0,
    maxCodeAttempts = 3,
    onstop,
    onswitch,
    onreply,
  }: Props = $props();

  const m = $derived(i18n.m);
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';
  const canScan = typeof globalThis !== 'undefined' && 'BarcodeDetector' in globalThis;
  let showQr = $state(false);
  let scanning = $state(false);
  let reply = $state('');
  let replyError = $state(false);
  // Manual mode is mostly "scan with the phone": show the QR right away.
  const qrVisible = $derived(showQr || mode === 'manual');

  async function share() {
    if (!link) return;
    try {
      await navigator.share({ title: m.share.shareTitle, url: link });
    } catch {
      // dismissed
    }
  }

  async function submit(code: string) {
    scanning = false;
    replyError = !(await onreply(code.trim()));
  }
</script>

<Card class="flex flex-col gap-5">
  <div>
    <h2 class="text-xl font-semibold">
      {mode === 'manual' ? m.share.manualTitle : mode === 'code' ? m.share.codeTitle : m.share.title}
    </h2>
    <p class="mt-1 text-sm text-muted">{summary}</p>
    {#if mode === 'manual'}
      <p class="mt-2 text-sm">{m.share.manualSteps}</p>
    {/if}
  </div>

  {#if mode === 'code'}
    {#if code}
      <p
        class="rounded-md bg-surface-2 px-4 py-5 text-center font-mono text-2xl font-semibold tracking-wide break-words sm:text-3xl"
        data-testid="short-code"
      >
        {code}
      </p>
      <CopyField
        value={code}
        label={m.share.codeLabel}
        copyLabel={m.share.copy}
        copiedLabel={m.share.copied}
        oncopy={(ok) => !ok && toast.error(m.share.copyFailed)}
      />
      <p class="text-sm text-muted">{m.share.codeHint}</p>
      {#if wrongCodes > 0}
        <p class="text-sm font-medium text-danger" role="alert">{m.share.wrongCode(wrongCodes, maxCodeAttempts)}</p>
      {/if}
    {:else}
      <p class="text-sm text-muted" role="status">{m.share.preparing}</p>
    {/if}
  {:else if link}
    <CopyField
      value={link}
      label={m.share.linkLabel}
      copyLabel={m.share.copy}
      copiedLabel={m.share.copied}
      oncopy={(ok) => !ok && toast.error(m.share.copyFailed)}
    />
    <div class="flex flex-wrap gap-2">
      {#if canShare}
        <Button variant="secondary" onclick={share}>
          <Share2 class="size-4" aria-hidden="true" />
          {m.share.shareButton}
        </Button>
      {/if}
      {#if mode === 'relay'}
        <Button variant="secondary" aria-expanded={showQr} onclick={() => (showQr = !showQr)}>
          <QrCodeIcon class="size-4" aria-hidden="true" />
          {showQr ? m.share.hideQr : m.share.showQr}
        </Button>
      {/if}
    </div>
    {#if qrVisible}
      <QrCode value={link} label={m.share.qrLabel} />
    {/if}
  {:else}
    <p class="text-sm text-muted" role="status">{m.share.preparing}</p>
  {/if}

  {#if mode === 'manual' && link && phase === 'waiting'}
    <form
      class="flex flex-col gap-2"
      onsubmit={(e) => {
        e.preventDefault();
        void submit(reply);
      }}
    >
      <label class="flex flex-col gap-1 text-sm font-medium">
        {m.share.replyLabel}
        <textarea
          class="min-h-20 rounded-md border border-border bg-surface px-3 py-2 font-mono text-xs"
          bind:value={reply}
          spellcheck="false"
          aria-invalid={replyError}
          aria-describedby={replyError ? 'reply-error' : undefined}
          oninput={() => (replyError = false)}
        ></textarea>
      </label>
      {#if replyError}
        <p id="reply-error" class="text-sm text-danger" role="alert">{m.share.replyInvalid}</p>
      {/if}
      <div class="flex flex-wrap gap-2">
        <Button type="submit" disabled={reply.trim().length === 0}>{m.share.connect}</Button>
        {#if canScan}
          <Button variant="secondary" onclick={() => (scanning = !scanning)}>
            <ScanLine class="size-4" aria-hidden="true" />
            {scanning ? m.share.stopScan : m.share.scan}
          </Button>
        {/if}
      </div>
      {#if scanning}
        <QrScanner
          label={m.share.scan}
          onresult={(text) => {
            reply = text;
            void submit(text);
          }}
          onerror={() => {
            scanning = false;
            toast.error(m.share.cameraFailed);
          }}
        />
      {/if}
    </form>
  {/if}

  {#if mode !== 'code'}
    <p class="flex gap-2 rounded-md bg-surface-2 p-3 text-sm text-muted">
      <TriangleAlert class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      {m.share.warning}
    </p>
  {/if}

  <div class="flex flex-col gap-2">
    <StatusStepper
      steps={[m.status.waiting, m.status.connecting, m.status.secured]}
      current={connectStep(phase)}
      label={m.share.title}
    />
    <p class="text-sm text-muted">{statusLine(m, phase, 'sender')} {m.share.keepOpen}</p>
  </div>

  <div class="flex flex-wrap gap-2">
    <Button variant="ghost" onclick={onstop}>{m.share.stop}</Button>
    {#if mode === 'relay'}
      <Button variant="ghost" onclick={() => onswitch('code')}>{m.share.toCode}</Button>
      <Button variant="ghost" onclick={() => onswitch('manual')}>{m.share.toManual}</Button>
    {:else}
      <Button variant="ghost" onclick={() => onswitch('relay')}>
        {mode === 'code' ? m.share.toLink : m.share.toRelay}
      </Button>
    {/if}
  </div>
</Card>
