<script lang="ts">
  import CircleCheck from '@lucide/svelte/icons/circle-check';
  import Download from '@lucide/svelte/icons/download';
  import { onMount } from 'svelte';
  import type { ErrorAction } from '../../lib/error-actions.ts';
  import { describeError } from '../../lib/errors.ts';
  import { formatBytes } from '../../lib/format.ts';
  import { i18n } from '../../lib/i18n/index.svelte.ts';
  import { baseName } from '../../lib/state/browser.ts';
  import { incoming } from '../../lib/state/link.svelte.ts';
  import type { ReceiveController, SaveTarget } from '../../lib/state/receive.svelte.ts';
  import { connectStep, statusLine, transferDetail } from '../../lib/transfer-text.ts';
  import { Button, Card, ErrorPanel, StatusStepper, TransferPanel } from '../../lib/ui/index.ts';
  import ReviewCard from './ReviewCard.svelte';

  let { ctrl }: { ctrl: ReceiveController } = $props();

  const m = $derived(i18n.m);

  onMount(() => {
    if (ctrl.phase === 'idle') void ctrl.start();
    return () => ctrl.cancel();
  });

  const SUPPORTED = new Set<ErrorAction>([
    'retry',
    'tryAgain',
    'keepWaiting',
    'startOver',
    'chooseFolder',
    'reload',
  ]);
  const errorView = $derived(
    incoming.status === 'invalid'
      ? { ...describeError('LINK_INVALID', m), actions: [] } // "Send files instead" is offered below
      : ctrl.error
        ? describeError(ctrl.error, m, SUPPORTED, 'tryAgain')
        : null,
  );

  const view = $derived.by(() => {
    if (incoming.status === 'invalid') return 'error';
    const p = ctrl.phase;
    if (p === 'reviewing' && ctrl.manifest) return 'review';
    if (p === 'transferring' || p === 'finishing') return 'transfer';
    if (p === 'done') return 'done';
    if (p === 'declined' && !ctrl.error) return 'declined';
    if (p === 'failed' || p === 'cancelled' || p === 'declined') return 'error';
    return 'connect';
  });

  const summary = $derived(
    m.send.summary(ctrl.manifest?.files.length ?? 0, formatBytes(ctrl.manifest?.total ?? 0)),
  );

  function onaction(id: string) {
    if (id === 'reload') location.reload();
    else if (id === 'askNewLink') sendInstead();
    else void ctrl.start();
  }

  async function accept(target: SaveTarget) {
    await ctrl.accept(target);
  }

  async function finish() {
    await ctrl.discard();
    sendInstead();
  }

  function sendInstead() {
    ctrl.cancel();
    incoming.clear();
  }
</script>

{#if view === 'connect'}
  <Card class="flex flex-col gap-5">
    <h1 class="text-xl font-semibold">{m.receive.connecting}</h1>
    <StatusStepper
      steps={[m.status.waiting, m.status.connecting, m.status.secured]}
      current={connectStep(ctrl.phase)}
      label={m.receive.connecting}
    />
    <p class="text-sm text-muted">{statusLine(m, ctrl.phase, 'receiver')}</p>
  </Card>
{:else if view === 'review' && ctrl.manifest}
  <ReviewCard
    files={ctrl.manifest.files}
    total={ctrl.manifest.total}
    canPickFolder={ctrl.canPickFolder}
    inMemory={ctrl.inMemory}
    onaccept={accept}
    ondecline={() => ctrl.decline()}
  />
{:else if view === 'transfer'}
  <Card>
    <TransferPanel
      title={ctrl.phase === 'finishing' ? m.transfer.finishing : `${m.transfer.receiving} ${summary}`}
      percent={ctrl.percent}
      detail={transferDetail(m, ctrl.done, ctrl.total, ctrl.rate)}
      progressLabel={m.transfer.progressLabel}
      labels={{
        cancel: m.transfer.cancel,
        confirm: m.transfer.confirmCancel,
        yes: m.transfer.yesCancel,
        no: m.transfer.keepGoing,
      }}
      oncancel={ctrl.phase === 'transferring' ? () => ctrl.cancel() : undefined}
    />
  </Card>
{:else if view === 'done'}
  <Card class="flex flex-col gap-5">
    <div class="flex flex-col items-center gap-3 text-center">
      <CircleCheck class="size-12 text-success" aria-hidden="true" />
      <h1 class="text-xl font-semibold">{m.done.saved}</h1>
      <p class="text-muted">
        {ctrl.savedTo?.kind === 'folder' ? m.done.savedToFolder(ctrl.savedTo.name) : m.done.ready}
      </p>
    </div>
    {#if ctrl.savedTo?.kind === 'download'}
      <ul class="divide-y divide-border rounded-md border border-border" aria-label={m.receive.reviewTitle}>
        {#each ctrl.savedTo.files as file (file.path)}
          <li class="flex min-h-12 items-center gap-3 px-3 py-2">
            <span class="min-w-0 flex-1 truncate text-sm" title={file.path}>{file.path}</span>
            <span class="shrink-0 text-sm text-muted tabular-nums">{formatBytes(file.size)}</span>
            <Button
              variant="secondary"
              size="icon"
              aria-label={m.done.download(baseName(file.path))}
              onclick={() => ctrl.save(file)}
            >
              <Download class="size-4" aria-hidden="true" />
            </Button>
          </li>
        {/each}
      </ul>
    {/if}
    <Button size="lg" variant={ctrl.savedTo?.kind === 'download' ? 'secondary' : 'primary'} onclick={finish}>
      {m.done.finish}
    </Button>
  </Card>
{:else if view === 'declined'}
  <Card class="flex flex-col gap-4">
    <p>{m.receive.declined}</p>
    <Button class="self-start" onclick={sendInstead}>{m.receive.sendInstead}</Button>
  </Card>
{:else if errorView}
  <Card class="flex flex-col gap-4">
    <ErrorPanel title={m.errorTitle} message={errorView.message} actions={errorView.actions} {onaction} />
    <Button variant="ghost" class="self-start" onclick={sendInstead}>{m.receive.sendInstead}</Button>
  </Card>
{/if}
