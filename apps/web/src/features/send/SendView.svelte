<script lang="ts">
  import Link2 from '@lucide/svelte/icons/link-2';
  import Lock from '@lucide/svelte/icons/lock';
  import { toast } from 'svelte-sonner';
  import { formatBytes } from '../../lib/format.ts';
  import { i18n } from '../../lib/i18n/index.svelte.ts';
  import { Button, Card, FileList } from '../../lib/ui/index.ts';
  import { fromFileList, mergePicked, type PickedFile } from './collect-files.ts';
  import DropZone from './DropZone.svelte';

  const m = $derived(i18n.m);

  let picked = $state<PickedFile[]>([]);
  const items = $derived(picked.map((p) => ({ path: p.path, size: p.file.size })));
  const total = $derived(picked.reduce((sum, p) => sum + p.file.size, 0));

  function add(files: PickedFile[]) {
    picked = mergePicked(picked, files);
    toast.success(m.send.added(files.length));
  }

  function onpaste(e: ClipboardEvent) {
    const files = e.clipboardData?.files;
    if (files && files.length > 0) {
      e.preventDefault();
      add(fromFileList(files));
    }
  }
</script>

<svelte:window {onpaste} />

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
      <Button size="lg" class="w-full" disabled aria-describedby="send-preview-note">
        <Link2 class="size-5" aria-hidden="true" />
        {m.send.createLink}
      </Button>
      <p id="send-preview-note" class="text-center text-sm text-muted">{m.send.preview}</p>
    </Card>
  {/if}

  <p class="flex items-start justify-center gap-2 text-center text-sm text-muted">
    <Lock class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
    {m.send.trust}
  </p>
</div>
