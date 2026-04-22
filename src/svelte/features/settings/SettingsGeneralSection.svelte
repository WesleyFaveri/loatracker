<script lang="ts">
  import { onMount } from 'svelte';
  import { UIHelper } from '../../utils/uiHelper';
  import { TOAST_TYPES } from '../../legacy/config/constants.js';
  import { withAsyncError } from '../../utils/errorWrappers';
  import { ERROR_CODES } from '../../utils/errorCodes';
  import type { AppApi, SettingsPayload } from '../../../types/app-api';
  import SettingsHeader from './SettingsHeader.svelte';
  import { notifyRosterChanged } from '../../stores/rosterSync';

  const ui = new UIHelper();
  const api: AppApi = window.api;

  let loading = true;
  let autoRaidOnFocus = false;
  let paradiseBetaUnlocked = false;
  let paradiseEnabled = false;
  let settings: SettingsPayload | null = null;

  let confirmOpen = false;
  let confirmInput = '';
  let confirmBusy = false;
  const confirmRequireText = 'RESET';

  $: confirmMatches = confirmInput.trim() === confirmRequireText;

  function showToast(message: string, type = TOAST_TYPES.INFO) {
    ui.showToast(message, type);
  }

  function emitSettingsChanged(next: SettingsPayload) {
    document.dispatchEvent(new CustomEvent('settingsChanged', { detail: { settings: next } }));
  }

  onMount(async () => {
    await withAsyncError(async () => {
      const loaded = await api.loadSettings();
      settings = (loaded || {}) as SettingsPayload;
      autoRaidOnFocus = Boolean(settings.autoRaidUpdateOnFocus);
      paradiseBetaUnlocked = Boolean(settings.paradiseBetaUnlocked);
      paradiseEnabled = Boolean(settings.paradiseEnabled);
      loading = false;
      return true;
    }, {
      code: ERROR_CODES.STATE.LOAD_FAILED,
      severity: 'error',
      context: { phase: 'SettingsGeneralSection.onMount', action: 'load-settings' },
      showToast: true,
    });
  });

  async function onAutoRaidToggle(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    autoRaidOnFocus = input.checked;
    if (!settings) return;

    const nextSettings: SettingsPayload = { ...settings, autoRaidUpdateOnFocus: autoRaidOnFocus };
    await withAsyncError(async () => {
      await api.saveSettings(nextSettings);
      settings = nextSettings;
      emitSettingsChanged(nextSettings);
      return true;
    }, {
      code: ERROR_CODES.STATE.SAVE_FAILED,
      severity: 'error',
      context: { phase: 'SettingsGeneralSection.onAutoRaidToggle', action: 'save-settings' },
      showToast: true,
    });
  }

  async function seedParadiseVisibilityFromWeekly() {
    const list = await api.getRosterList?.();
    if (!Array.isArray(list)) return;

    let anyChanged = false;
    for (const meta of list) {
      const rosterId = String(meta?.id || '');
      if (!rosterId) continue;

      const loaded = await api.loadRoster(rosterId);
      const roster = loaded?.roster || {};
      const order = Array.isArray(loaded?.order) ? loaded.order : [];

      const nextRoster: Record<string, unknown> = {};
      let changed = false;
      for (const [name, value] of Object.entries(roster)) {
        if (name === 'dailyData' || !value || typeof value !== 'object') {
          nextRoster[name] = value;
          continue;
        }
        const entry = value as Record<string, unknown>;
        if (entry.visible === false || entry.visibleInParadise === true) {
          nextRoster[name] = entry;
          continue;
        }
        nextRoster[name] = { ...entry, visibleInParadise: true };
        changed = true;
      }

      if (changed) {
        await api.saveRoster(rosterId, { roster: nextRoster, order });
        anyChanged = true;
      }
    }

    if (anyChanged) {
      notifyRosterChanged();
    }
  }

  async function onParadiseToggle(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const wasEnabled = Boolean(settings?.paradiseEnabled);
    paradiseEnabled = input.checked;
    if (!settings) return;

    const nextSettings: SettingsPayload = { ...settings, paradiseEnabled };
    await withAsyncError(async () => {
      await api.saveSettings(nextSettings);
      settings = nextSettings;
      emitSettingsChanged(nextSettings);
      if (!wasEnabled && paradiseEnabled) {
        await seedParadiseVisibilityFromWeekly();
      }
      return true;
    }, {
      code: ERROR_CODES.STATE.SAVE_FAILED,
      severity: 'error',
      context: { phase: 'SettingsGeneralSection.onParadiseToggle', action: 'save-settings' },
      showToast: true,
    });
  }

  function openResetConfirm() {
    confirmInput = '';
    confirmBusy = false;
    confirmOpen = true;
  }

  function closeResetConfirm() {
    confirmOpen = false;
    confirmInput = '';
    confirmBusy = false;
  }

  async function executeReset() {
    if (!confirmMatches || confirmBusy) return;
    confirmBusy = true;
    await withAsyncError(async () => {
      await api.resetAppData?.();
      showToast('App data reset. Reloading…', TOAST_TYPES.SUCCESS);
      window.setTimeout(() => window.location.reload(), 180);
      return true;
    }, {
      code: ERROR_CODES.UI.ACTION_FAILED,
      severity: 'error',
      context: { phase: 'SettingsGeneralSection.executeReset', action: 'reset-app-data' },
      showToast: true,
    });
    confirmBusy = false;
  }
</script>

<SettingsHeader title="General" hint="Controls for automatic refresh and local data cleanup." />

<div class="settings-bottom-grid">
  <div class="settings-section">
    <h3>Auto raid refresh</h3>
    <p class="settings-compact-hint">When enabled, raid data refreshes whenever the app regains focus.</p>
    <label class="settings-auto-raid-toggle" for="auto-raid-on-focus">
      <input
        id="auto-raid-on-focus"
        type="checkbox"
        checked={autoRaidOnFocus}
        on:change={onAutoRaidToggle}
        disabled={loading}
        aria-label="Auto update on focus when database is loaded"
      />
    </label>
  </div>

  {#if paradiseBetaUnlocked}
    <div class="settings-section">
      <h3>Paradise <span class="paradise-beta-badge">BETA</span></h3>
      <p class="settings-compact-hint">Enables the experimental Paradise Tracker. A new tab appears in the header, and each character in Roster Management gains a "Show in Paradise" toggle.</p>
      <label class="settings-auto-raid-toggle" for="paradise-enabled">
        <input
          id="paradise-enabled"
          type="checkbox"
          checked={paradiseEnabled}
          on:change={onParadiseToggle}
          disabled={loading}
          aria-label="Enable Paradise Tracker"
        />
      </label>
    </div>
  {/if}

  <div class="settings-section settings-danger-zone">
    <h3>App data</h3>
    <p class="settings-danger-copy">Removes saved roster and settings data from this browser.</p>
    <button id="reset-app-data-btn" type="button" class="danger-action-btn" on:click={openResetConfirm} disabled={loading}>Reset app data</button>
  </div>
</div>

<style>
  .paradise-beta-badge {
    display: inline-block;
    margin-left: 8px;
    padding: 2px 6px;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.05em;
    border-radius: 4px;
    background: #a855f7;
    color: #fff;
    vertical-align: middle;
  }
</style>

{#if confirmOpen}
  <div class="settings-confirm-overlay" role="dialog" aria-modal="true" aria-labelledby="settings-confirm-title">
    <div class="settings-confirm-card">
      <h3 id="settings-confirm-title">Reset all app data?</h3>
      <p>This will erase local roster and settings data in this browser and reload the page.</p>

      <label for="settings-confirm-input">Type <strong>{confirmRequireText}</strong> to continue</label>
      <input
        id="settings-confirm-input"
        type="text"
        bind:value={confirmInput}
        placeholder={confirmRequireText}
        autocomplete="off"
        spellcheck="false"
      />

      <div class="settings-confirm-actions">
        <button type="button" on:click={closeResetConfirm} disabled={confirmBusy}>Cancel</button>
        <button
          type="button"
          class="danger-action-btn"
          on:click={executeReset}
          disabled={confirmBusy || !confirmMatches}
        >
          {confirmBusy ? 'Processing…' : 'Confirm'}
        </button>
      </div>
    </div>
  </div>
{/if}
