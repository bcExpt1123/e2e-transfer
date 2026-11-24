<script lang="ts">
  import { toast } from 'svelte-sonner';
  import { i18n } from '../../lib/i18n/index.svelte.ts';
  import { DEFAULTS } from '../../lib/state/network.ts';
  import { parseList, type SettingsProblem, settings } from '../../lib/state/settings.svelte.ts';
  import { Button } from '../../lib/ui/index.ts';

  const m = $derived(i18n.m);
  const current = settings.network;

  let relays = $state(current.nostrRelays.join('\n'));
  let brokers = $state(current.mqttBrokers.join('\n'));
  let stun = $state(current.stunUrls.join('\n'));
  let turnUrl = $state(current.turn?.urls ?? '');
  let turnUser = $state(current.turn?.username ?? '');
  let turnPassword = $state(current.turn?.credential ?? '');
  let problem = $state<SettingsProblem | null>(null);

  function save(e: SubmitEvent) {
    e.preventDefault();
    const turn = turnUrl.trim()
      ? { urls: turnUrl.trim(), username: turnUser.trim(), credential: turnPassword }
      : null;
    problem = settings.save({
      nostrRelays: parseList(relays),
      mqttBrokers: parseList(brokers),
      stunUrls: parseList(stun),
      turn,
    });
    if (!problem) toast.success(m.settings.saved);
  }

  function reset() {
    settings.reset();
    relays = brokers = stun = turnUrl = turnUser = turnPassword = '';
    problem = null;
  }

  const field = 'rounded-md border border-border bg-surface px-3 font-normal';
</script>

<form class="flex flex-col gap-4" onsubmit={save} novalidate aria-describedby="network-hint">
  <p id="network-hint" class="text-sm text-muted">{m.settings.networkHint}</p>

  <label class="flex flex-col gap-1 text-sm font-medium">
    {m.settings.nostrRelays}
    <textarea class="{field} min-h-20 py-2 font-mono text-xs" bind:value={relays} placeholder="wss://relay.example.org" spellcheck="false"></textarea>
    <span class="text-xs font-normal text-muted">{m.settings.listHint}</span>
  </label>
  <label class="flex flex-col gap-1 text-sm font-medium">
    {m.settings.mqttBrokers}
    <textarea class="{field} min-h-16 py-2 font-mono text-xs" bind:value={brokers} placeholder="wss://broker.example.org/mqtt" spellcheck="false"></textarea>
  </label>
  <label class="flex flex-col gap-1 text-sm font-medium">
    {m.settings.stun}
    <textarea class="{field} min-h-16 py-2 font-mono text-xs" bind:value={stun} placeholder={DEFAULTS.stun.join('\n')} spellcheck="false"></textarea>
  </label>

  <fieldset class="flex flex-col gap-2">
    <legend class="text-sm font-medium">{m.settings.turn}</legend>
    <p class="text-xs text-muted">{m.settings.turnHint}</p>
    <label class="flex flex-col gap-1 text-sm">
      {m.settings.turnUrl}
      <input class="{field} h-11 font-mono text-xs" bind:value={turnUrl} placeholder="turns:turn.example.org:443" spellcheck="false" autocomplete="off" />
    </label>
    <div class="grid grid-cols-2 gap-2">
      <label class="flex flex-col gap-1 text-sm">
        {m.settings.turnUser}
        <input class="{field} h-11" bind:value={turnUser} autocomplete="off" />
      </label>
      <label class="flex flex-col gap-1 text-sm">
        {m.settings.turnPassword}
        <input class="{field} h-11" type="password" bind:value={turnPassword} autocomplete="off" />
      </label>
    </div>
  </fieldset>

  {#if problem}
    <p class="text-sm text-danger" role="alert">{m.settings.problems[problem]}</p>
  {/if}

  <div class="flex flex-wrap gap-2">
    <Button type="submit">{m.settings.save}</Button>
    <Button variant="ghost" onclick={reset}>{m.settings.reset}</Button>
  </div>
</form>
