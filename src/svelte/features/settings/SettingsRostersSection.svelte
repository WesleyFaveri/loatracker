<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { RosterService } from '../../services/RosterService';
  import type { RosterMeta } from '../../../types/app-api';
  import {
    consumePendingManageRoster,
    notifyRosterChanged,
    notifyVisibleRostersChanged,
    rosterChangeVersion,
  } from '../../stores/rosterSync';
  import RosterPage from '../roster/RosterPage.svelte';
  import SettingsHeader from './SettingsHeader.svelte';
  import { UIHelper } from '../../utils/uiHelper';
  import { TOAST_TYPES } from '../../legacy/config/constants.js';
  import { withAsyncError } from '../../utils/errorWrappers';
  import { ERROR_CODES } from '../../utils/errorCodes';

  type DialogMode = 'create' | 'rename' | 'delete' | null;

  const ui = new UIHelper();

  let rosters: RosterMeta[] = [];
  let activeRosterId = '';
  let loading = true;
  let manageOpen = false;
  let unsubscribe: (() => void) | null = null;

  let dialogMode: DialogMode = null;
  let dialogTargetRosterId = '';
  let dialogNameInput = '';
  let dialogBusy = false;

  $: dialogOpen = dialogMode !== null;
  $: sortedRosters = [...rosters].sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));
  $: dialogTargetRoster = sortedRosters.find((r) => r.id === dialogTargetRosterId) || null;
  $: dialogTitle = dialogMode === 'create'
    ? 'Create roster'
    : dialogMode === 'rename'
      ? 'Rename roster'
      : dialogMode === 'delete'
        ? 'Delete roster'
        : '';
  $: dialogConfirmLabel = dialogMode === 'create'
    ? 'Create'
    : dialogMode === 'rename'
      ? 'Rename'
      : dialogMode === 'delete'
        ? 'Delete'
        : 'Confirm';
  $: dialogCanConfirm = dialogMode === 'delete'
    ? Boolean(dialogTargetRosterId && dialogTargetRoster && sortedRosters.length > 1)
    : Boolean(dialogNameInput.trim());

  function showToast(message: string, type = TOAST_TYPES.INFO) {
    ui.showToast(message, type);
  }

  async function refresh() {
    await withAsyncError(async () => {
      const snapshot = await RosterService.loadRosterSwitcherState();
      rosters = snapshot.rosters;
      activeRosterId = snapshot.activeRosterId;
      loading = false;
      return true;
    }, {
      code: ERROR_CODES.ROSTER_SWITCHER.REFRESH_FAILED,
      severity: 'error',
      context: { phase: 'SettingsRostersSection.refresh', action: 'load-rosters' },
      showToast: true,
    });
  }

  onMount(async () => {
    await window.__API_READY__;
    await refresh();

    let initial = true;
    unsubscribe = rosterChangeVersion.subscribe(() => {
      if (initial) {
        initial = false;
        return;
      }
      void refresh();
    });

    // Honor a pending request to auto-open Manage (e.g. after "Add Manually"
    // from Tracker Integration). Consuming clears the store so this only fires
    // on the originating navigation.
    const pendingRosterId = consumePendingManageRoster();
    if (pendingRosterId) {
      await openManage(pendingRosterId);
    }
  });

  onDestroy(() => {
    unsubscribe?.();
    unsubscribe = null;
  });

  async function openManage(rosterId: string) {
    if (!rosterId) return;
    if (rosterId !== activeRosterId) {
      await RosterService.switchActiveRoster(rosterId);
      activeRosterId = rosterId;
      notifyRosterChanged();
    }
    manageOpen = true;
  }

  function closeManage() {
    manageOpen = false;
  }

  function onOverlayClick(event: MouseEvent) {
    if (event.target === event.currentTarget) {
      closeManage();
    }
  }

  function onOverlayKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeManage();
    }
  }

  function openCreateDialog() {
    dialogMode = 'create';
    dialogTargetRosterId = '';
    dialogNameInput = '';
    dialogBusy = false;
  }

  function openRenameDialog(roster: RosterMeta) {
    dialogMode = 'rename';
    dialogTargetRosterId = roster.id;
    dialogNameInput = roster.name || '';
    dialogBusy = false;
  }

  function openDeleteDialog(roster: RosterMeta) {
    if (sortedRosters.length <= 1) return;
    dialogMode = 'delete';
    dialogTargetRosterId = roster.id;
    dialogNameInput = roster.name || '';
    dialogBusy = false;
  }

  function closeDialog() {
    dialogMode = null;
    dialogTargetRosterId = '';
    dialogNameInput = '';
    dialogBusy = false;
  }

  async function confirmDialog() {
    if (!dialogMode || dialogBusy || !dialogCanConfirm) return;
    dialogBusy = true;

    const result = await withAsyncError(async () => {
      if (dialogMode === 'create') {
        const name = dialogNameInput.trim();
        const newRosterId = await RosterService.createRoster(name);
        if (newRosterId) {
          await RosterService.switchActiveRoster(newRosterId);
        }
        await refresh();
        notifyRosterChanged();
        notifyVisibleRostersChanged();
        showToast('Roster created', TOAST_TYPES.SUCCESS);
        closeDialog();
        return true;
      }

      if (dialogMode === 'rename' && dialogTargetRosterId && dialogTargetRoster) {
        const nextName = dialogNameInput.trim();
        if (!nextName || nextName === dialogTargetRoster.name) {
          closeDialog();
          return true;
        }
        await RosterService.renameRoster(dialogTargetRosterId, nextName);
        await refresh();
        notifyRosterChanged();
        showToast('Roster renamed', TOAST_TYPES.SUCCESS);
        closeDialog();
        return true;
      }

      if (dialogMode === 'delete' && dialogTargetRosterId && sortedRosters.length > 1) {
        await RosterService.deleteRoster(dialogTargetRosterId);
        await refresh();
        notifyRosterChanged();
        notifyVisibleRostersChanged();
        showToast('Roster deleted', TOAST_TYPES.SUCCESS);
        closeDialog();
        return true;
      }
      return true;
    }, {
      code: ERROR_CODES.ROSTER_SWITCHER.ACTION_FAILED,
      severity: 'error',
      context: {
        phase: 'SettingsRostersSection.confirmDialog',
        action: dialogMode ? `roster-${dialogMode}` : 'roster-dialog-action',
        rosterId: dialogTargetRosterId,
        dialogMode,
      },
      showToast: true,
    });

    if (result === null) {
      dialogBusy = false;
    }
  }

  function onDialogOverlayClick(event: MouseEvent) {
    if (event.target === event.currentTarget && !dialogBusy) {
      closeDialog();
    }
  }

  function onDialogKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape' && !dialogBusy) {
      event.preventDefault();
      closeDialog();
    }
  }
</script>

<SettingsHeader title="Rosters" hint="All rosters stored in this browser. Open Manage to edit characters, priorities and visibility." />

<div class="settings-rosters-list" aria-label="Roster list">
  {#if loading}
    <p class="settings-compact-hint">Loading…</p>
  {:else if sortedRosters.length === 0}
    <p class="settings-compact-hint">No rosters yet.</p>
  {:else}
    {#each sortedRosters as roster (roster.id)}
      <div class="settings-roster-row" class:active={roster.id === activeRosterId}>
        <div class="settings-roster-row__info">
          <div class="settings-roster-row__name">{roster.name}</div>
          {#if roster.id === activeRosterId}
            <span class="settings-roster-row__badge">Active</span>
          {/if}
        </div>
        <span class="settings-roster-row__chip">{Number(roster.characterCount || 0)} chars</span>
        <div class="settings-roster-row__actions">
          <button type="button" class="settings-roster-row__action" on:click={() => openRenameDialog(roster)}>Rename</button>
          {#if sortedRosters.length > 1}
            <button type="button" class="settings-roster-row__action danger" on:click={() => openDeleteDialog(roster)}>Delete</button>
          {/if}
          <button type="button" class="settings-roster-row__manage" on:click={() => openManage(roster.id)}>Manage</button>
        </div>
      </div>
    {/each}
  {/if}

  {#if !loading}
    <button type="button" class="settings-rosters-create" on:click={openCreateDialog}>+ Create roster</button>
  {/if}
</div>

{#if dialogOpen}
  <div
    id="roster-action-dialog"
    class="roster-action-dialog"
    role="dialog"
    aria-modal="true"
    aria-label={dialogTitle}
    tabindex="0"
    on:click={onDialogOverlayClick}
    on:keydown={onDialogKeydown}
  >
    <div class="modal-overlay"></div>
    <div class="roster-action-dialog__card" role="document">
      <h3 class="roster-action-dialog__title">{dialogTitle}</h3>
      {#if dialogMode === 'delete' && dialogTargetRoster}
        <p class="roster-action-dialog__text">Delete <strong>{dialogTargetRoster.name}</strong>? This cannot be undone.</p>
      {:else}
        <label class="roster-action-dialog__label" for="roster-action-dialog-name">Roster name</label>
        <input
          id="roster-action-dialog-name"
          type="text"
          bind:value={dialogNameInput}
          maxlength="42"
          autocomplete="off"
          spellcheck="false"
          on:keydown={(event) => event.key === 'Enter' && dialogCanConfirm && !dialogBusy && confirmDialog()}
        />
      {/if}

      <div class="roster-action-dialog__actions">
        <button type="button" class="btn-secondary" on:click={closeDialog} disabled={dialogBusy}>Cancel</button>
        <button
          type="button"
          class="btn-primary"
          class:danger={dialogMode === 'delete'}
          on:click={confirmDialog}
          disabled={!dialogCanConfirm || dialogBusy}
        >
          {dialogBusy ? 'Working…' : dialogConfirmLabel}
        </button>
      </div>
    </div>
  </div>
{/if}

{#if manageOpen}
  <div
    id="roster-manage-modal"
    class="roster-manage-modal"
    role="dialog"
    aria-modal="true"
    aria-labelledby="roster-manage-title"
    tabindex="0"
    on:click={onOverlayClick}
    on:keydown={onOverlayKeydown}
  >
    <div class="modal-overlay"></div>
    <div class="roster-manage-content" role="document">
      <button type="button" class="close-btn" aria-label="Close roster manage" on:click={closeManage}>×</button>
      <RosterPage />
    </div>
  </div>
{/if}

<style>
  .settings-rosters-list {
    display: flex;
    flex-direction: column;
    gap: var(--spacing-sm);
  }

  .settings-roster-row {
    display: flex;
    align-items: center;
    gap: var(--spacing-md);
    padding: 12px 14px;
    background: color-mix(in srgb, var(--color-surface-light) 88%, var(--color-surface));
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    transition: border-color var(--transition-fast), background var(--transition-fast);
  }

  .settings-roster-row.active {
    border-color: color-mix(in srgb, var(--color-primary) 52%, var(--color-border));
    background: color-mix(in srgb, var(--color-primary) 10%, var(--color-surface));
  }

  .settings-roster-row__info {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .settings-roster-row__name {
    font-weight: 700;
    color: var(--color-text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .settings-roster-row__chip {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 58px;
    height: 28px;
    padding: 0 8px;
    border-radius: var(--radius-md);
    border: 1px solid color-mix(in srgb, var(--color-border-light) 62%, var(--color-border));
    background: color-mix(in srgb, var(--color-surface-light) 88%, var(--color-surface));
    color: var(--color-text-secondary);
    font-size: 0.7rem;
    font-weight: 700;
    letter-spacing: 0.02em;
    text-transform: uppercase;
    white-space: nowrap;
  }

  .settings-roster-row__badge {
    font-size: 0.68rem;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    padding: 2px 6px;
    border-radius: var(--radius-sm);
    background: var(--color-primary);
    color: var(--color-bg-dark);
  }

  .settings-roster-row__actions {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .settings-roster-row__action {
    min-height: 32px;
    padding: 0 12px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--color-border);
    background: var(--color-surface);
    color: var(--color-text-secondary);
    font-size: 0.8rem;
    font-weight: 600;
    cursor: pointer;
    transition: all var(--transition-fast);
  }

  .settings-roster-row__action:hover {
    background: var(--color-surface-hover);
    color: var(--color-text);
    transform: translateY(-1px);
  }

  .settings-roster-row__action.danger {
    color: color-mix(in srgb, var(--color-error) 80%, var(--color-text));
    border-color: color-mix(in srgb, var(--color-error) 40%, var(--color-border));
  }

  .settings-roster-row__action.danger:hover {
    background: color-mix(in srgb, var(--color-error) 14%, var(--color-surface));
    color: var(--color-error);
  }

  .settings-roster-row__manage {
    min-height: 32px;
    padding: 0 14px;
    border-radius: var(--radius-sm);
    border: 1px solid color-mix(in srgb, var(--color-primary) 46%, var(--color-border));
    background: color-mix(in srgb, var(--color-primary) 18%, var(--color-surface));
    color: var(--color-primary);
    font-size: 0.8rem;
    font-weight: 700;
    cursor: pointer;
    transition: all var(--transition-fast);
  }

  .settings-roster-row__manage:hover {
    background: color-mix(in srgb, var(--color-primary) 28%, var(--color-surface));
    transform: translateY(-1px);
  }

  .settings-rosters-create {
    margin-top: 4px;
    min-height: 40px;
    padding: 0 16px;
    border-radius: var(--radius-md);
    border: 1px dashed color-mix(in srgb, var(--color-primary) 50%, var(--color-border));
    background: transparent;
    color: var(--color-primary);
    font-size: 0.85rem;
    font-weight: 700;
    cursor: pointer;
    transition: all var(--transition-fast);
  }

  .settings-rosters-create:hover {
    background: color-mix(in srgb, var(--color-primary) 12%, transparent);
    border-style: solid;
  }

  .roster-action-dialog {
    position: fixed;
    inset: 0;
    z-index: 10040;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .roster-action-dialog .modal-overlay {
    position: absolute;
    inset: 0;
    background: rgba(0, 0, 0, 0.72);
    z-index: 1;
  }

  .roster-action-dialog__card {
    position: relative;
    z-index: 2;
    width: min(92vw, 420px);
    padding: var(--spacing-lg);
    border: 1px solid color-mix(in srgb, var(--color-border-light) 62%, var(--color-border));
    border-radius: var(--radius-lg);
    background: linear-gradient(180deg,
      color-mix(in srgb, var(--color-surface-light) 92%, var(--color-surface)) 0%,
      color-mix(in srgb, var(--color-surface) 90%, var(--color-bg-darker)) 100%);
    box-shadow: var(--shadow-lg);
    display: flex;
    flex-direction: column;
    gap: var(--spacing-md);
  }

  .roster-action-dialog__title {
    margin: 0;
    color: var(--color-primary);
    font-size: 1.05rem;
    font-weight: 700;
  }

  .roster-action-dialog__text {
    margin: 0;
    color: var(--color-text-secondary);
    line-height: 1.45;
  }

  .roster-action-dialog__label {
    font-size: 0.8rem;
    color: var(--color-text-secondary);
  }

  .roster-action-dialog__card input {
    width: 100%;
    min-height: 36px;
    padding: 6px 12px;
    box-sizing: border-box;
    border-radius: var(--radius-sm);
    border: 1px solid color-mix(in srgb, var(--color-border-light) 56%, var(--color-border));
    background: var(--color-bg-dark);
    color: var(--color-text);
  }

  .roster-action-dialog__actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--spacing-sm);
  }

  .roster-action-dialog__actions .btn-secondary,
  .roster-action-dialog__actions .btn-primary {
    min-height: 34px;
    padding: 0 14px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--color-border);
    background: var(--color-surface);
    color: var(--color-text-secondary);
    font-size: 0.82rem;
    font-weight: 700;
    cursor: pointer;
  }

  .roster-action-dialog__actions .btn-primary {
    border-color: color-mix(in srgb, var(--color-primary) 46%, var(--color-border));
    background: color-mix(in srgb, var(--color-primary) 18%, var(--color-surface));
    color: var(--color-primary);
  }

  .roster-action-dialog__actions .btn-primary.danger {
    border-color: color-mix(in srgb, var(--color-error) 50%, var(--color-border));
    background: color-mix(in srgb, var(--color-error) 18%, var(--color-surface));
    color: var(--color-error);
  }

  .roster-action-dialog__actions button:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }

</style>
