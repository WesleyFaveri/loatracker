<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import type { AppApi, ParadiseData, ParadiseRaidKey } from '../../../types/app-api';
  import { UIHelper } from '../../utils/uiHelper';
  import { CLASS_ICONS, TOAST_TYPES } from '../../legacy/config/constants.js';
  import { rosterChangeVersion } from '../../stores/rosterSync';
  import { characterKeys, normalizeCharacter, orderedEntries } from '../roster/rosterDomain';
  import { formatItemLevelDisplay } from '../../utils/formValidator';
  import {
    PARADISE_RAID_KEYS,
    PARADISE_RAID_LABELS,
    applyWeeklyResetIfNeeded,
    emptyParadiseEntry,
    getParadiseWeekKey,
    normalizeParadiseData,
    normalizeParadiseEntry,
    setParadiseCheckbox,
  } from './paradiseDomain';

  const api: AppApi = window.api;
  const ui = new UIHelper();

  let activeRosterId = '';
  let roster: Record<string, unknown> = {};
  let order: string[] = [];
  let paradise: ParadiseData = { weekKey: '', data: {} };
  let loading = true;
  let resetConfirmOpen = false;
  let resetBusy = false;
  let unsubscribeRosterChanges: (() => void) | null = null;
  // Bumped on reset so {#each} keys change and checkbox DOM nodes remount,
  // forcing Svelte to write the fresh `checked={false}` property even after
  // the user toggled the box (browser keeps the live property otherwise).
  let resetNonce = 0;

  $: visibleEntries = orderedEntries(roster, order).filter(
    (entry) => entry.data.visibleInParadise === true,
  );

  function showToast(message: string, type = TOAST_TYPES.INFO) {
    ui.showToast(message, type);
  }

  function getClassIconPath(className: string): string | null {
    const icon = (CLASS_ICONS as Record<string, string>)[className];
    return icon ? `./assets/icons/${icon}` : null;
  }

  async function resolveActiveRosterId(): Promise<string> {
    const current = await api.getActiveRoster?.();
    const currentId = String(current || '').trim();
    if (currentId) return currentId;

    const list = await api.getRosterList?.();
    if (Array.isArray(list) && list.length > 0) {
      const fallback = String(list[0]?.id || '').trim();
      if (fallback) {
        await api.switchActiveRoster?.(fallback);
        return fallback;
      }
    }

    const created = await api.createRoster?.('Main Roster');
    if (created) {
      await api.switchActiveRoster?.(created);
      return created;
    }

    return '';
  }

  async function loadAll() {
    loading = true;
    try {
      activeRosterId = await resolveActiveRosterId();
      if (!activeRosterId) {
        roster = {};
        order = [];
        paradise = { weekKey: getParadiseWeekKey(), data: {} };
        return;
      }

      const loaded = await api.loadRoster(activeRosterId);
      roster = loaded?.roster || {};
      const keys = characterKeys(roster);
      const loadedOrder = Array.isArray(loaded?.order) ? loaded.order.filter((name) => keys.includes(name)) : [];
      const missing = keys.filter((name) => !loadedOrder.includes(name));
      order = [...loadedOrder, ...missing];

      const storedRaw = await api.loadParadiseData?.(activeRosterId);
      const stored = normalizeParadiseData(storedRaw);
      const names = orderedEntries(roster, order)
        .filter((entry) => entry.data.visibleInParadise === true)
        .map((entry) => entry.name);
      const { data: nextData, changed } = applyWeeklyResetIfNeeded(stored, names);
      paradise = nextData;
      if (changed) {
        await api.saveParadiseData?.(activeRosterId, paradise);
      }
    } finally {
      loading = false;
    }
  }

  function getEntry(name: string) {
    return normalizeParadiseEntry(paradise.data[name] ?? emptyParadiseEntry());
  }

  async function onCheckboxChange(name: string, key: ParadiseRaidKey, event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    if (!activeRosterId) return;
    paradise = setParadiseCheckbox(paradise, name, key, input.checked);
    try {
      await api.saveParadiseData?.(activeRosterId, paradise);
    } catch {
      showToast('Failed to save Paradise data.', TOAST_TYPES.ERROR);
    }
  }

  function openResetConfirm() {
    if (loading) return;
    resetConfirmOpen = true;
  }

  function closeResetConfirm() {
    if (resetBusy) return;
    resetConfirmOpen = false;
  }

  async function executeReset() {
    if (resetBusy || !activeRosterId) return;
    resetBusy = true;
    try {
      paradise = { weekKey: getParadiseWeekKey(), data: {} };
      resetNonce += 1;
      await api.saveParadiseData?.(activeRosterId, paradise);
      showToast('Paradise data reset.', TOAST_TYPES.SUCCESS);
      resetConfirmOpen = false;
    } catch {
      showToast('Failed to reset Paradise data.', TOAST_TYPES.ERROR);
    } finally {
      resetBusy = false;
    }
  }

  function getCharacterClass(name: string): string {
    const entry = roster[name];
    if (!entry) return '';
    return normalizeCharacter(entry).class;
  }

  function getCharacterIlvl(name: string): number {
    const entry = roster[name];
    if (!entry) return 0;
    return normalizeCharacter(entry).ilvl;
  }

  onMount(async () => {
    await window.__API_READY__;
    await loadAll();

    let isInitial = true;
    unsubscribeRosterChanges = rosterChangeVersion.subscribe(() => {
      if (isInitial) { isInitial = false; return; }
      void loadAll();
    });
  });

  onDestroy(() => {
    unsubscribeRosterChanges?.();
    unsubscribeRosterChanges = null;
  });
</script>

<section class="tab-content active paradise-tab" id="paradise-tab" aria-live="polite">
  <div class="paradise-header">
    <div class="paradise-title">
      <h2>Paradise Tracker</h2>
      <span class="paradise-beta-pill">BETA</span>
    </div>
    <button
      type="button"
      class="paradise-reset-btn"
      on:click={openResetConfirm}
      disabled={loading}
    >
      Reset Data
    </button>
  </div>

  {#if loading}
    <p class="paradise-empty">Loading Paradise Tracker…</p>
  {:else}
    <table class="tracker-table paradise-table">
          <thead>
            <tr>
              <th>Character</th>
              {#each PARADISE_RAID_KEYS as key (key)}
                <th>{PARADISE_RAID_LABELS[key]}</th>
              {/each}
            </tr>
          </thead>
          <tbody>
            {#if visibleEntries.length === 0}
              <tr>
                <td colspan={PARADISE_RAID_KEYS.length + 1} class="paradise-empty-row">
                  No characters set to show in Paradise. Enable "Show in Paradise" on a character from Roster Management.
                </td>
              </tr>
            {:else}
              {#each visibleEntries as entry (entry.name + ':' + resetNonce)}
                {@const current = getEntry(entry.name)}
                {@const classIconPath = getClassIconPath(getCharacterClass(entry.name))}
                <tr>
                  <td class="char-cell">
                    <div class="char-name" title={entry.name}>
                      <span class="char-name-text">{entry.name}</span>
                      {#if classIconPath}
                        <img src={classIconPath} alt={getCharacterClass(entry.name)} width="28" height="28" />
                      {/if}
                    </div>
                    <div class="char-info">
                      <span class="char-class">{getCharacterClass(entry.name)}</span>
                      <span class="char-ilvl">({formatItemLevelDisplay(getCharacterIlvl(entry.name))})</span>
                    </div>
                  </td>

                  {#each PARADISE_RAID_KEYS as key (key)}
                    <td class="boss-cell paradise-check-cell">
                      <input
                        class="daily-checkmark"
                        type="checkbox"
                        checked={current[key]}
                        on:change={(event) => onCheckboxChange(entry.name, key, event)}
                        aria-label={`${PARADISE_RAID_LABELS[key]} for ${entry.name}`}
                      />
                    </td>
                  {/each}
                </tr>
              {/each}
            {/if}
          </tbody>
        </table>
      {/if}
</section>

{#if resetConfirmOpen}
  <div class="settings-confirm-overlay" role="dialog" aria-modal="true" aria-labelledby="paradise-reset-title">
    <div class="settings-confirm-card">
      <h3 id="paradise-reset-title">Reset Paradise data?</h3>
      <p>This clears every Paradise checkbox for the active roster. Weekly Tracker data is not affected.</p>
      <div class="settings-confirm-actions">
        <button type="button" on:click={closeResetConfirm} disabled={resetBusy}>Cancel</button>
        <button
          type="button"
          class="danger-action-btn"
          on:click={executeReset}
          disabled={resetBusy}
        >
          {resetBusy ? 'Resetting…' : 'Confirm reset'}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .paradise-tab {
    display: block;
    width: fit-content;
    max-width: 100%;
    margin: 0 auto;
  }

  .paradise-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 4px 2px 14px;
    flex-wrap: wrap;
  }

  .paradise-title {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .paradise-title h2 {
    margin: 0;
    font-size: 18px;
    color: var(--color-text);
  }

  .paradise-beta-pill {
    padding: 2px 8px;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.05em;
    border-radius: 999px;
    background: #a855f7;
    color: #fff;
  }

  .paradise-reset-btn {
    background: var(--color-surface);
    color: var(--color-text-secondary);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    padding: 6px 14px;
    font-size: 13px;
    cursor: pointer;
  }

  .paradise-reset-btn:hover:not(:disabled) {
    background: var(--color-surface-hover);
    color: var(--color-text);
  }

  .paradise-reset-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .paradise-empty {
    padding: 24px 8px;
    color: var(--color-text-secondary);
    font-size: 14px;
  }

  .paradise-empty-row {
    padding: 24px 12px;
    color: var(--color-text-secondary);
    font-size: 14px;
    text-align: center;
  }

  .paradise-check-cell {
    text-align: center;
  }
</style>
