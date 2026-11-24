<script lang="ts">
  import KeyRound from '@lucide/svelte/icons/key-round';
  import { i18n } from '../../lib/i18n/index.svelte.ts';
  import { codeTools } from '../../lib/state/code-tools.ts';
  import { incoming } from '../../lib/state/link.svelte.ts';
  import { Button } from '../../lib/ui/index.ts';

  const m = $derived(i18n.m);
  let value = $state('');
  let invalid = $state(false);
  let suggestions = $state<string[]>([]);

  // Suggest completions for the word being typed: "7-gui" → "7-guide", "7-guilt", "7-guitar".
  async function oninput() {
    invalid = false;
    const tools = await codeTools();
    const parts = value.split(/[\s-]+/);
    const last = parts.at(-1) ?? '';
    const head = parts.slice(0, -1).join('-');
    suggestions =
      parts.length >= 2 && /^[a-z]{2,}$/i.test(last)
        ? tools.completeWord(last).map((w) => `${head}-${w}`)
        : [];
  }

  async function onsubmit(e: SubmitEvent) {
    e.preventDefault();
    const tools = await codeTools();
    const code = tools.parseCode(value);
    if (!code) {
      invalid = true;
      return;
    }
    incoming.enterCode(tools.formatCode(code));
  }
</script>

<form class="flex flex-col gap-2" {onsubmit} novalidate>
  <label for="code-entry" class="flex items-center gap-2 text-sm font-medium">
    <KeyRound class="size-4 text-muted" aria-hidden="true" />
    {m.codeEntry.title}
  </label>
  <div class="flex gap-2">
    <input
      id="code-entry"
      class="h-11 min-w-0 flex-1 rounded-md border border-border bg-surface px-3 font-mono"
      bind:value
      {oninput}
      onfocus={() => void codeTools()}
      placeholder={m.codeEntry.placeholder}
      aria-label={m.codeEntry.label}
      aria-invalid={invalid}
      aria-describedby={invalid ? 'code-entry-error' : undefined}
      autocomplete="off"
      autocapitalize="off"
      spellcheck="false"
      list="code-suggestions"
    />
    <Button type="submit" variant="secondary" disabled={value.trim().length === 0}>{m.codeEntry.submit}</Button>
  </div>
  <datalist id="code-suggestions">
    {#each suggestions as s (s)}
      <option value={s}></option>
    {/each}
  </datalist>
  {#if invalid}
    <p id="code-entry-error" class="text-sm text-danger" role="alert">{m.codeEntry.invalid}</p>
  {/if}
</form>
