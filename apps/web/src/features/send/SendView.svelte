<script lang="ts">
  import CircleCheck from '@lucide/svelte/icons/circle-check';
  import Link2 from '@lucide/svelte/icons/link-2';
  import Lock from '@lucide/svelte/icons/lock';
  import { untrack } from 'svelte';
  import { toast } from 'svelte-sonner';
  import type { ErrorAction } from '../../lib/error-actions.ts';
  import { describeError } from '../../lib/errors.ts';
  import { formatBytes } from '../../lib/format.ts';
  import { i18n } from '../../lib/i18n/index.svelte.ts';
  import {
    CODE_MAX_ATTEMPTS,
    isTerminalPhase,
    MAX_RECEIVERS,
    type SendController,
  } from '../../lib/state/send.svelte.ts';
  import { appUi, settings } from '../../lib/state/settings.svelte.ts';
  import { statusLine, transferLine, transferTitle } from '../../lib/transfer-text.ts';
  import { Button, Card, ErrorPanel, FileList, StatusStepper, TransferPanel } from '../../lib/ui/index.ts';
  import ApproveCard from './ApproveCard.svelte';
  import { fromFileList, mergePicked, type PickedFile } from './collect-files.ts';
  import DropZone from './DropZone.svelte';
  import ReceiverList from './ReceiverList.svelte';
  import ShareCard from './ShareCard.svelte';

  interface Props {
    ctrl: SendController;
    /** Files from the OS share sheet (PWA Share Target), added once. */
    shared?: File[];
    onshared?: () => void;
  }

  let { ctrl, shared = [], onshared }: Props = $props();

  const m = $derived(i18n.m);

  let picked = $state<PickedFile[]>([]);
  const items = $derived(picked.map((p) => ({ path: p.path, size: p.file.size })));
  const total = $derived(picked.reduce((sum, p) => sum + p.file.size, 0));
  const summary = $derived(m.send.summary(ctrl.fileCount || picked.length, formatBytes(ctrl.total || total)));

  const SUPPORTED = new Set<ErrorAction>([
    'retry',
    'tryAgain',
    'keepWaiting',
    'startOver',
    'reload',
    'configureTurn',
    'learnMore',
    'useQr',
    'newCode',
  ]);
  const errorView = $derived(ctrl.error ? describeError(ctrl.error, m, SUPPORTED) : null);

  // "Several devices": the link stays up; each device shows up in a list instead of taking over the screen.
  const sharing = $derived(ctrl.multi && (ctrl.phase === 'joining' || ctrl.phase === 'waiting'));
  const anyoneConnected = $derived(ctrl.receivers.some((r) => !isTerminalPhase(r.phase)));

  const view = $derived.by(() => {
    const p = ctrl.phase;
    if (p === 'idle') return 'pick';
    if (sharing) return 'share';
    if (p === 'joining' || p === 'waiting' || p === 'connecting' || p === 'handshaking') return 'share';
    if (p === 'connected' && ctrl.confirming) return 'approve';
    if (p === 'connected' || p === 'awaiting-accept') return 'accepting';
    if (p === 'transferring' || p === 'finishing' || p === 'reconnecting') return 'transfer';
    if (p === 'done') return 'done';
    return 'error';
  });

  function add(files: PickedFile[]) {
    if (view !== 'pick') return;
    picked = mergePicked(picked, files);
    toast.success(m.send.added(files.length));
  }

  $effect(() => {
    if (shared.length === 0) return;
    untrack(() => add(fromFileList(shared)));
    onshared?.();
  });

  function onpaste(e: ClipboardEvent) {
    const files = e.clipboardData?.files;
    if (view === 'pick' && files && files.length > 0) {
      e.preventDefault();
      add(fromFileList(files));
    }
  }

  function onaction(id: string) {
    if (id === 'configureTurn') appUi.settingsOpen = true;
    else if (id === 'learnMore') appUi.aboutOpen = true;
    else if (id === 'reload') location.reload();
    else if (id === 'useQr') ctrl.switchMode('manual');
    else if (id === 'newCode') ctrl.retry();
    else if (id === 'startOver') ctrl.reset();
    else ctrl.retry();
  }

  function sendMore() {
    ctrl.reset();
    picked = [];
  }
</script>

<svelte:window {onpaste} />

{#if view === 'pick'}
  <div class="flex flex-col gap-6">
    <DropZone
      onfiles={add}
      labels={{
        title: m.send.dropTitle,
        hint: m.send.dropHint,
        chooseFiles: m.send.chooseFiles,
        chooseFolder: m.send.chooseFolder,
      }}
    />

    {#if picked.length > 0}
      <Card class="flex flex-col gap-4">
        <div class="flex items-center justify-between gap-4">
          <h2 class="font-semibold">
            {m.send.selected}
            <span class="ml-1 font-normal text-muted">{m.send.summary(picked.length, formatBytes(total))}</span>
          </h2>
          <Button variant="ghost" onclick={() => (picked = [])}>{m.send.clear}</Button>
        </div>
        <FileList
          {items}
          label={m.send.selected}
          onremove={(i) => (picked = picked.filter((_, j) => j !== i))}
          removeLabel={m.send.remove}
        />
        <Button size="lg" class="w-full" onclick={() => ctrl.share(picked)}>
          <Link2 class="size-5" aria-hidden="true" />
          {m.send.createLink}
        </Button>
      </Card>
    {/if}

    <p class="flex items-start justify-center gap-2 text-center text-sm text-muted">
      <Lock class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      {m.send.trust}
    </p>
  </div>
{:else if view === 'share'}
  {#if sharing && ctrl.peer}
    {#key ctrl.peer.key}
      <div class="mb-4">
        <ApproveCard
          {summary}
          words={ctrl.peer.words}
          hint={ctrl.peer.hint}
          onsend={() => ctrl.approve()}
          ondecline={() => ctrl.decline()}
        />
      </div>
    {/key}
  {/if}
  <ShareCard
    link={ctrl.link}
    phase={ctrl.phase}
    mode={ctrl.mode}
    code={ctrl.code}
    wrongCodes={ctrl.wrongCodes}
    maxCodeAttempts={CODE_MAX_ATTEMPTS}
    {summary}
    multi={ctrl.multi}
    maxReceivers={MAX_RECEIVERS}
    onmulti={anyoneConnected ? undefined : (on) => ctrl.setMulti(on)}
    onstop={() => ctrl.reset()}
    onswitch={(mode) => ctrl.switchMode(mode)}
    onreply={(code) => ctrl.submitReply(code)}
  />
  {#if sharing && ctrl.receivers.length > 0}
    <div class="mt-4">
      <ReceiverList receivers={ctrl.receivers} oncancel={(key) => ctrl.cancelReceiver(key)} />
    </div>
  {/if}
{:else if view === 'approve'}
  <ApproveCard {summary} words={ctrl.peer?.words ?? []} hint={ctrl.peer?.hint} onsend={() => ctrl.approve()} ondecline={() => ctrl.decline()} />
{:else if view === 'accepting'}
  <Card class="flex flex-col gap-4">
    <StatusStepper
      steps={[m.status.waiting, m.status.connecting, m.status.secured]}
      current={3}
      label={m.share.title}
    />
    <p class="text-sm text-muted">{statusLine(m, ctrl.phase, 'sender')}</p>
    <Button variant="ghost" class="self-start" onclick={() => ctrl.cancel()}>{m.common.cancel}</Button>
  </Card>
{:else if view === 'transfer'}
  <Card>
    <TransferPanel
      title={transferTitle(m, ctrl.phase, m.transfer.sending, summary)}
      percent={ctrl.percent}
      busy={ctrl.phase === 'reconnecting'}
      detail={transferLine(m, ctrl.phase, ctrl.done, ctrl.total, ctrl.rate)}
      progressLabel={m.transfer.progressLabel}
      labels={{
        cancel: m.transfer.cancel,
        confirm: m.transfer.confirmCancel,
        yes: m.transfer.yesCancel,
        no: m.transfer.keepGoing,
      }}
      oncancel={ctrl.phase === 'finishing' ? undefined : () => ctrl.cancel()}
    />
  </Card>
{:else if view === 'done'}
  <Card class="flex flex-col items-center gap-4 text-center">
    <CircleCheck class="size-12 text-success" aria-hidden="true" />
    <div>
      <h2 class="text-xl font-semibold">{m.done.delivered}</h2>
      <p class="mt-1 text-muted">{m.done.deliveredBody(summary)}</p>
    </div>
    <Button size="lg" onclick={sendMore}>{m.done.sendMore}</Button>
  </Card>
{:else if errorView}
  <Card>
    <ErrorPanel title={m.errorTitle} message={errorView.code === 'ICE_FAILED' && settings.hasTurn ? m.iceFailedWithTurn : errorView.message} actions={errorView.actions} {onaction} />
  </Card>
{/if}
