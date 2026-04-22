<script lang="ts">
  import { onMount } from 'svelte';
  import { UIHelper } from '../../utils/uiHelper';
  import { TOAST_TYPES } from '../../legacy/config/constants.js';
  import { withAsyncError } from '../../utils/errorWrappers';
  import { ERROR_CODES } from '../../utils/errorCodes';
  import type { AppApi, SettingsPayload } from '../../../types/app-api';
  import SettingsHeader from './SettingsHeader.svelte';

  const ui = new UIHelper();
  const api: AppApi = window.api;

  let loading = true;
  let autoRaidOnFocus = false;
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

  <div class="settings-section settings-danger-zone">
    <h3>App data</h3>
    <p class="settings-danger-copy">Removes saved roster and settings data from this browser.</p>
    <button id="reset-app-data-btn" type="button" class="danger-action-btn" on:click={openResetConfirm} disabled={loading}>Reset app data</button>
  </div>
</div>

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
