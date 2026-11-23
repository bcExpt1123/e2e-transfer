<script lang="ts">
  import FolderOpen from '@lucide/svelte/icons/folder-open';
  import Upload from '@lucide/svelte/icons/upload';
  import { Button } from '../../lib/ui/index.ts';
  import { collectFromDataTransfer, fromFileList, type PickedFile } from './collect-files.ts';

  interface Props {
    onfiles: (files: PickedFile[]) => void;
    labels: { title: string; hint: string; chooseFiles: string; chooseFolder: string };
  }

  let { onfiles, labels }: Props = $props();

  let dragDepth = $state(0);
  const dragging = $derived(dragDepth > 0);
  let fileInput = $state<HTMLInputElement>();
  let folderInput = $state<HTMLInputElement>();

  const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes('Files') ?? false;

  function ondrop(e: DragEvent) {
    e.preventDefault();
    dragDepth = 0;
    if (!e.dataTransfer) return;
    // capture synchronously; see collectFromDataTransfer
    collectFromDataTransfer(e.dataTransfer).then((files) => files.length > 0 && onfiles(files));
  }

  function fromInput(e: Event & { currentTarget: HTMLInputElement }) {
    const input = e.currentTarget;
    if (input.files && input.files.length > 0) onfiles(fromFileList(input.files));
    input.value = '';
  }
</script>

<div
  role="group"
  aria-label={labels.title}
  class={[
    'flex flex-col items-center gap-4 rounded-lg border-2 border-dashed px-6 py-10 text-center transition-colors sm:py-14',
    dragging ? 'border-accent bg-accent-soft' : 'border-border bg-surface',
  ]}
  ondragenter={(e) => hasFiles(e) && dragDepth++}
  ondragleave={(e) => hasFiles(e) && (dragDepth = Math.max(0, dragDepth - 1))}
  ondragover={(e) => hasFiles(e) && e.preventDefault()}
  {ondrop}
>
  <span class="inline-flex size-14 items-center justify-center rounded-full bg-accent-soft text-accent">
    <Upload class="size-7" aria-hidden="true" />
  </span>
  <div>
    <p class="text-lg font-semibold">{labels.title}</p>
    <p class="mt-1 text-sm text-muted">{labels.hint}</p>
  </div>
  <div class="flex flex-wrap justify-center gap-2">
    <Button onclick={() => fileInput?.click()}>
      <Upload class="size-4" aria-hidden="true" />
      {labels.chooseFiles}
    </Button>
    <Button variant="secondary" onclick={() => folderInput?.click()}>
      <FolderOpen class="size-4" aria-hidden="true" />
      {labels.chooseFolder}
    </Button>
  </div>
  <input
    bind:this={fileInput}
    type="file"
    multiple
    hidden
    data-testid="file-input"
    onchange={fromInput}
  />
  <input
    bind:this={folderInput}
    type="file"
    webkitdirectory
    hidden
    data-testid="folder-input"
    onchange={fromInput}
  />
</div>
