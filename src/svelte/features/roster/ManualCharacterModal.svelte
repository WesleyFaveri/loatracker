<script lang="ts">
  import type { AppApi } from '../../../types/app-api';
  import { CHARACTER_CLASSES, TOAST_TYPES } from '../../legacy/config/constants.js';
  import { UIHelper } from '../../utils/uiHelper';
  import {
    ROSTER_VALIDATION,
    sanitizeCharacterNameInput,
    sanitizeDecimalInput,
    validateRosterFormDetailed,
  } from '../../utils/formValidator';
  import { withAsyncError } from '../../utils/errorWrappers';
  import { ERROR_CODES } from '../../utils/errorCodes';
  import { notifyRosterChanged } from '../../stores/rosterSync';
  import { loadRosterState, persistRosterState, upsertCharacter } from './rosterDomain';

  /**
   * Standalone "add character manually" modal. Reads the currently-active roster
   * on open, persists a new character with the shared roster domain helpers, and
   * notifies other views via {@link notifyRosterChanged} so the sidebar/Weekly
   * tracker stay in sync without needing a full page navigation.
   */
  export let open = false;
  export let onClose: () => void;
  /**
   * Fired once the character has been persisted successfully, just before the
   * modal closes. Receives the active roster id so callers can jump to the
   * corresponding roster view. Errors or validation failures do not trigger
   * this callback.
   */
  export let onAfterAdd: ((rosterId: string) => void) | undefined = undefined;

  const api: AppApi = window.api;
  const ui = new UIHelper();

  let activeRosterId = '';
  let roster: Record<string, unknown> = {};
  let order: string[] = [];
  let loading = false;
  let submitting = false;

  let formName = '';
  let formClass = '';
  let formIlvl = '';
  let formCombatPower = '';

  // Reactive watcher: react whenever the `open` prop flips so we can either
  // load the currently-active roster (on open) or reset the form (on close).
  // A small computed value is used so ESLint sees `open` being consumed.
  $: void handleOpenChange(open);

  let lastOpen = false;
  function handleOpenChange(next: boolean) {
    if (next === lastOpen) return;
    lastOpen = next;
    if (next) {
      void loadState();
    } else {
      resetForm();
    }
  }

  async function loadState() {
    loading = true;
    const result = await withAsyncError(
      () => loadRosterState(api, ''),
      {
        code: ERROR_CODES.STATE.LOAD_FAILED,
        severity: 'error',
        context: { phase: 'ManualCharacterModal.loadState', action: 'load-active-roster' },
        showToast: true,
      }
    );
    if (result) {
      activeRosterId = result.activeRosterId;
      roster = result.roster;
      order = result.order;
    }
    loading = false;
  }

  function resetForm() {
    formName = '';
    formClass = '';
    formIlvl = '';
    formCombatPower = '';
  }

  function showToast(message: string, type: string = TOAST_TYPES.INFO) {
    ui.showToast(message, type);
  }

  function handleNameInput() {
    formName = sanitizeCharacterNameInput(formName);
  }

  function handleItemLevelInput() {
    formIlvl = sanitizeDecimalInput(formIlvl, {
      decimalPlaces: ROSTER_VALIDATION.ITEM_LEVEL_DECIMAL_PLACES,
      min: ROSTER_VALIDATION.ITEM_LEVEL_MIN,
      max: ROSTER_VALIDATION.ITEM_LEVEL_MAX,
      allowEmpty: true,
    });
  }

  function handleCombatPowerInput() {
    formCombatPower = sanitizeDecimalInput(formCombatPower, {
      decimalPlaces: ROSTER_VALIDATION.COMBAT_POWER_DECIMAL_PLACES,
      min: 0,
      allowEmpty: true,
    });
  }

  async function submit() {
    if (loading || submitting) return;

    const validation = validateRosterFormDetailed({
      name: formName,
      characterClass: formClass,
      itemLevelRaw: formIlvl,
      combatPowerRaw: formCombatPower,
    });

    if (!validation.isValid) {
      showToast(validation.issue?.message || 'Invalid character data', TOAST_TYPES.ERROR);
      return;
    }

    submitting = true;
    const completed = await withAsyncError(async () => {
      const roundedIlvl = Math.round(Number(formIlvl) * 100) / 100;
      const rawCp = Number(formCombatPower);
      const roundedCp = Number.isFinite(rawCp) && rawCp > 0 ? Math.round(rawCp * 100) / 100 : null;

      const next = upsertCharacter(roster, order, {
        name: formName,
        class: String(formClass || '').trim(),
        ilvl: roundedIlvl,
        combatPower: roundedCp,
      });

      const rosterId = await persistRosterState(api, activeRosterId, next.roster, next.order);
      activeRosterId = rosterId;
      roster = next.roster;
      order = next.order;
      notifyRosterChanged();
      showToast('Character added', TOAST_TYPES.SUCCESS);
      return true;
    }, {
      code: ERROR_CODES.DB.WRITE_FAILED,
      severity: 'error',
      context: {
        phase: 'ManualCharacterModal.submit',
        action: 'add-character-manually',
        rosterId: activeRosterId,
      },
      showToast: true,
    });
    submitting = false;

    if (completed) {
      const persistedRosterId = activeRosterId;
      onClose();
      onAfterAdd?.(persistedRosterId);
    }
  }

  function onOverlayClick(event: MouseEvent) {
    if (event.target === event.currentTarget && !submitting) {
      onClose();
    }
  }

  function onOverlayKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape' && !submitting) {
      event.preventDefault();
      onClose();
    }
  }
</script>

{#if open}
  <div
    class="roster-form-overlay"
    role="dialog"
    aria-modal="true"
    aria-labelledby="manual-character-modal-title"
    tabindex="0"
    on:click={onOverlayClick}
    on:keydown={onOverlayKeydown}
  >
    <div class="roster-form-panel" role="document">
      <div class="roster-form-header">
        <h3 id="manual-character-modal-title">Add Character</h3>
        <button
          type="button"
          class="roster-form-close"
          on:click={onClose}
          disabled={submitting}
          aria-label="Close add character form"
        >×</button>
      </div>

      <form class="add-character" aria-label="Add character" on:submit|preventDefault={submit}>
        <input
          type="text"
          placeholder="Character Name"
          bind:value={formName}
          on:input={handleNameInput}
          disabled={loading || submitting}
        />

        <select bind:value={formClass} disabled={loading || submitting}>
          <option value="">Select Class</option>
          {#each CHARACTER_CLASSES as className (className)}
            <option value={className}>{className}</option>
          {/each}
        </select>

        <input
          placeholder="Item Level"
          type="text"
          inputmode="decimal"
          bind:value={formIlvl}
          on:input={handleItemLevelInput}
          disabled={loading || submitting}
        />

        <input
          placeholder="Combat Power (optional)"
          type="text"
          inputmode="decimal"
          bind:value={formCombatPower}
          on:input={handleCombatPowerInput}
          disabled={loading || submitting}
        />

        <button type="submit" disabled={loading || submitting}>
          {submitting ? 'Adding…' : 'Add Character'}
        </button>

        <button type="button" on:click={onClose} disabled={submitting}>Cancel</button>
      </form>
    </div>
  </div>
{/if}
