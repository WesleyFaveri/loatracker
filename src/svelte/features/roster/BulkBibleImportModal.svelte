<script lang="ts">
  import type { AppApi, RosterPayload } from '../../../types/app-api';
  import { MATHI_API_CONFIG, TOAST_TYPES, mapApiClassToDisplay } from '../../legacy/config/constants.js';
  import { BibleApiRequestError, BibleApiService, type BibleRegion } from '../../services/BibleApiService';
  import { UIHelper } from '../../utils/uiHelper';
  import { formatCombatPowerDisplay, formatItemLevelDisplay } from '../../utils/formValidator';
  import { withAsyncError } from '../../utils/errorWrappers';
  import { ERROR_CODES } from '../../utils/errorCodes';
  import { notifyRosterChanged } from '../../stores/rosterSync';
  import {
    normalizeBibleClass,
    normalizeBibleCombatPower,
    normalizeBibleIlvl,
    normalizeCharacter,
  } from './rosterDomain';

  type SortField = 'ilvl' | 'combatPower' | 'name';
  type SortDirection = 'asc' | 'desc';
  type Step = 'seed' | 'preview';

  type PreviewCharacter = {
    name: string;
    class: string;
    ilvl: number;
    combatPower: number | null;
    selected: boolean;
    alreadyInRoster: boolean;
    /** True when the existing roster entry already matches the Bible payload,
     * so the row locks as a checked confirmation instead of tempting the user
     * to uncheck it. */
    upToDate: boolean;
  };

  export let open = false;
  export let rosterId: string;
  export let roster: Record<string, unknown> = {};
  export let order: string[] = [];
  export let onClose: () => void;
  export let onImported: ((summary: { imported: number; updated: number }) => void) | undefined = undefined;

  const api: AppApi = window.api;
  const ui = new UIHelper();

  let step: Step = 'seed';
  let seedInput = '';
  let region: BibleRegion = (MATHI_API_CONFIG.DEFAULT_REGION === 'EU' ? 'EU' : 'NA');
  let loading = false;
  let submitting = false;
  let preview: PreviewCharacter[] = [];
  let sortField: SortField = 'ilvl';
  let sortDirection: SortDirection = 'desc';

  // Reset step/input whenever the modal opens so each invocation starts
  // fresh; Svelte only re-fires this block when `open` changes value.
  $: if (open) resetForOpen();
  function resetForOpen() {
    step = 'seed';
    seedInput = '';
    preview = [];
  }

  // Single pass over preview to compute the action tallies used by the
  // footer label and the submit button's disabled state.
  $: selectionCounts = preview.reduce(
    (acc, entry) => {
      if (!entry.selected) return acc;
      if (!entry.alreadyInRoster) acc.newCount += 1;
      else if (!entry.upToDate) acc.updateCount += 1;
      return acc;
    },
    { newCount: 0, updateCount: 0 },
  );
  $: actionableSelectedCount = selectionCounts.newCount + selectionCounts.updateCount;
  $: importButtonLabel = buildImportLabel(selectionCounts.newCount, selectionCounts.updateCount);
  $: sortedPreview = sortPreview(preview, sortField, sortDirection);

  function buildImportLabel(newCount: number, updateCount: number) {
    const parts: string[] = [];
    if (newCount > 0) parts.push(`Import ${newCount} new`);
    if (updateCount > 0) parts.push(`Update ${updateCount}`);
    return parts.length > 0 ? parts.join(' + ') : 'Import';
  }

  function sortPreview(items: PreviewCharacter[], field: SortField, direction: SortDirection) {
    const sign = direction === 'desc' ? -1 : 1;
    return [...items].sort((a, b) => {
      if (field === 'name') return a.name.localeCompare(b.name) * sign;
      const left = Number(a[field] || 0);
      const right = Number(b[field] || 0);
      if (left === right) return a.name.localeCompare(b.name);
      return left > right ? sign : -sign;
    });
  }

  function toggleSort(field: SortField) {
    if (sortField === field) {
      sortDirection = sortDirection === 'desc' ? 'asc' : 'desc';
      return;
    }
    sortField = field;
    sortDirection = 'desc';
  }

  function showToast(message: string, type: string = TOAST_TYPES.INFO) {
    ui.showToast(message, type);
  }

  async function search() {
    const trimmed = seedInput.trim();
    if (!trimmed) {
      showToast('Enter a character name to search.', TOAST_TYPES.WARNING);
      return;
    }
    loading = true;
    await withAsyncError(async () => {
      let rows: Awaited<ReturnType<typeof BibleApiService.fetchFullRoster>>;
      try {
        rows = await BibleApiService.fetchFullRoster(region, trimmed);
      } catch (error) {
        const isNotFound = error instanceof BibleApiRequestError
          ? error.status === 404
          : String(error || '').includes('HTTP 404');
        if (isNotFound) {
          showToast('Character not found on Bible API. Check the name and region.', TOAST_TYPES.ERROR);
          return true;
        }
        throw error;
      }

      if (!Array.isArray(rows) || rows.length === 0) {
        showToast('No characters found on Bible API.', TOAST_TYPES.WARNING);
        return true;
      }

      preview = rows
        .map((row) => {
          const rawRow = row as Record<string, unknown>;
          const name = String(rawRow?.name || '').trim();
          const existing = name ? roster[name] : undefined;
          const alreadyInRoster = Boolean(existing);
          const normalizedClass = normalizeBibleClass(mapApiClassToDisplay(String(rawRow?.class ?? '')));
          const normalizedIlvl = normalizeBibleIlvl(rawRow?.ilvl);
          const normalizedCp = normalizeBibleCombatPower(
            rawRow?.combatPower ?? (rawRow as { combat_power?: unknown })?.combat_power,
          );

          let upToDate = false;
          if (alreadyInRoster) {
            const existingNormalized = normalizeCharacter(existing);
            const sameClass = existingNormalized.class === normalizedClass;
            const sameIlvl = Math.abs(existingNormalized.ilvl - normalizedIlvl) < 0.01;
            const sameCp = (existingNormalized.combatPower ?? null) === (normalizedCp ?? null)
              || (existingNormalized.combatPower != null
                && normalizedCp != null
                && Math.abs(existingNormalized.combatPower - normalizedCp) < 0.01);
            upToDate = sameClass && sameIlvl && sameCp;
          }

          return {
            name,
            class: normalizedClass,
            ilvl: normalizedIlvl,
            combatPower: normalizedCp,
            selected: alreadyInRoster,
            alreadyInRoster,
            upToDate,
          } as PreviewCharacter;
        })
        .filter((entry) => entry.name);

      if (preview.length === 0) {
        showToast('No valid characters returned by Bible API.', TOAST_TYPES.WARNING);
        return true;
      }

      step = 'preview';
      return true;
    }, {
      code: ERROR_CODES.NETWORK.REQUEST_FAILED,
      severity: 'error',
      context: {
        phase: 'BulkBibleImportModal.search',
        action: 'fetch-full-roster',
        rosterId,
        region,
        characterName: trimmed,
      },
      showToast: true,
    });
    loading = false;
  }

  function toggleEntry(name: string, nextSelected: boolean) {
    preview = preview.map((entry) => (
      entry.name === name && !entry.upToDate
        ? { ...entry, selected: nextSelected }
        : entry
    ));
  }

  function selectAllNew() {
    preview = preview.map((entry) => (entry.alreadyInRoster ? entry : { ...entry, selected: true }));
  }

  // Up-to-date rows stay checked — they are locked confirmations, not
  // actionable toggles.
  function deselectAll() {
    preview = preview.map((entry) => (entry.upToDate ? entry : { ...entry, selected: false }));
  }

  async function performImport() {
    const selected = preview.filter((entry) => entry.selected);
    if (selected.length === 0) {
      showToast('Select at least one character to import.', TOAST_TYPES.WARNING);
      return;
    }
    if (!rosterId) {
      showToast('No active roster selected.', TOAST_TYPES.ERROR);
      return;
    }

    submitting = true;
    const summary = { imported: 0, updated: 0 };
    const completed = await withAsyncError(async () => {
      const nextRoster: Record<string, unknown> = { ...roster };
      const nextOrder: string[] = [...order];

      for (const entry of selected) {
        if (entry.upToDate) continue;
        const existing = nextRoster[entry.name] as Record<string, unknown> | undefined;
        if (existing) {
          nextRoster[entry.name] = {
            ...existing,
            class: entry.class,
            ilvl: entry.ilvl,
            combatPower: entry.combatPower,
          };
          summary.updated += 1;
        } else {
          nextRoster[entry.name] = {
            class: entry.class,
            ilvl: entry.ilvl,
            visible: true,
            combatPower: entry.combatPower,
          };
          nextOrder.push(entry.name);
          summary.imported += 1;
        }
      }

      await api.saveRoster(rosterId, { roster: nextRoster, order: nextOrder } as RosterPayload);
      notifyRosterChanged();

      const parts: string[] = [];
      if (summary.imported > 0) parts.push(`${summary.imported} imported`);
      if (summary.updated > 0) parts.push(`${summary.updated} updated`);
      showToast(parts.join(', ') || 'No changes', TOAST_TYPES.SUCCESS);
      return true;
    }, {
      code: ERROR_CODES.DB.WRITE_FAILED,
      severity: 'error',
      context: {
        phase: 'BulkBibleImportModal.performImport',
        action: 'merge-selected-characters',
        rosterId,
        selectedCount: selected.length,
      },
      showToast: true,
    });
    submitting = false;

    if (completed) {
      onImported?.(summary);
      onClose();
    }
  }

  function backToSeed() {
    step = 'seed';
  }

  function onOverlayClick(event: MouseEvent) {
    if (event.target === event.currentTarget && !submitting && !loading) {
      onClose();
    }
  }

  function onOverlayKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape' && !submitting && !loading) {
      event.preventDefault();
      onClose();
    }
  }
</script>

{#if open}
  <div
    class="roster-form-overlay bulk-import-overlay"
    role="dialog"
    aria-modal="true"
    aria-labelledby="bulk-import-title"
    tabindex="0"
    on:click={onOverlayClick}
    on:keydown={onOverlayKeydown}
  >
    <div class="roster-form-panel bulk-import-panel" role="document">
      <button
        type="button"
        class="close-btn bulk-import-close"
        on:click={onClose}
        disabled={submitting || loading}
        aria-label="Close bulk roster import"
      >×</button>

      {#if step === 'seed'}
        <h2 id="bulk-import-title">Add roster from Bible</h2>
        <p class="bulk-import-lead">Enter name of <strong>any character</strong> from your roster:</p>

        <div class="wizard-info">
          <h4>💡 Tip:</h4>
          <p>The app fetches all characters associated with this roster. Characters already in your roster will be highlighted and can be updated in the same flow.</p>
        </div>

        <form class="form-row bulk-import-seed-row" on:submit|preventDefault={search}>
          <div class="form-group form-group-name">
            <label for="bulk-import-name">Character name:</label>
            <input
              id="bulk-import-name"
              type="text"
              bind:value={seedInput}
              autocomplete="off"
              disabled={loading}
            />
          </div>
          <div class="form-group form-group-region">
            <label for="bulk-import-region">Region:</label>
            <select id="bulk-import-region" bind:value={region} disabled={loading}>
              {#each MATHI_API_CONFIG.REGIONS as item (item)}
                <option value={item}>{item}</option>
              {/each}
            </select>
          </div>

          <div class="modal-buttons bulk-import-seed-buttons">
            <button type="button" class="wizard-secondary-btn" on:click={onClose} disabled={loading}>Cancel</button>
            <button type="submit" class="wizard-primary-btn" disabled={loading || !seedInput.trim()}>
              <span class="btn-label">{loading ? 'Searching…' : 'Search'}</span>
            </button>
          </div>
        </form>
      {:else}
        <h2 id="bulk-import-title">Select characters to import</h2>
        <p class="bulk-import-lead">Check the characters you want to add or update in your roster:</p>

        <div class="wizard-preview-actions">
          <button type="button" class="wizard-secondary-btn" on:click={selectAllNew} disabled={submitting}>Select all new</button>
          <button type="button" class="wizard-secondary-btn" on:click={deselectAll} disabled={submitting}>Deselect all</button>
        </div>

        <div class="wizard-character-list-header bulk-import-list-header">
          <div></div>
          <div>Name</div>
          <div>Class</div>
          <button type="button" class="wizard-sort-header-btn" class:active={sortField === 'ilvl'} on:click={() => toggleSort('ilvl')}>
            <span>iLvl</span>
            <span class="wizard-sort-arrow">{sortField === 'ilvl' ? (sortDirection === 'desc' ? '↓' : '↑') : '↕'}</span>
          </button>
          <button type="button" class="wizard-sort-header-btn" class:active={sortField === 'combatPower'} on:click={() => toggleSort('combatPower')}>
            <span>CP</span>
            <span class="wizard-sort-arrow">{sortField === 'combatPower' ? (sortDirection === 'desc' ? '↓' : '↑') : '↕'}</span>
          </button>
        </div>

        <div class="wizard-character-list bulk-import-list">
          {#each sortedPreview as entry (entry.name)}
            <div
              class="wizard-character-item"
              class:is-uptodate={entry.upToDate}
              role="button"
              tabindex={entry.upToDate ? -1 : 0}
              aria-label={entry.upToDate
                ? `${entry.name} (already up to date)`
                : `Character ${entry.name}`}
              aria-pressed={entry.selected}
              aria-disabled={entry.upToDate}
              on:click={(event) => {
                if (entry.upToDate) return;
                if (event.target instanceof HTMLInputElement) return;
                toggleEntry(entry.name, !entry.selected);
              }}
              on:keydown={(event) => {
                if (entry.upToDate) return;
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                toggleEntry(entry.name, !entry.selected);
              }}
            >
              <input
                type="checkbox"
                checked={entry.selected}
                disabled={submitting || entry.upToDate}
                aria-label={`Select ${entry.name}`}
                on:click|stopPropagation
                on:change={(event) => toggleEntry(entry.name, (event.currentTarget as HTMLInputElement).checked)}
              />
              <div class="wizard-character-info">
                <div class="wizard-character-name">{entry.name}</div>
                <div class="wizard-character-class">{entry.class}</div>
                <div class="wizard-character-ilvl">iLvl: {formatItemLevelDisplay(entry.ilvl)}</div>
                <div class="wizard-character-cp">CP: {entry.combatPower ? formatCombatPowerDisplay(entry.combatPower) : '—'}</div>
              </div>
            </div>
          {/each}
        </div>

        <div class="modal-buttons bulk-import-footer">
          <button type="button" class="wizard-secondary-btn" on:click={backToSeed} disabled={submitting}>Back</button>
          <button
            type="button"
            class="wizard-primary-btn"
            on:click={performImport}
            disabled={submitting || actionableSelectedCount === 0}
          >
            <span class="btn-label">{submitting ? 'Importing…' : importButtonLabel}</span>
          </button>
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  /* Mirrors the `.wizard-modal` rules scoped to this panel so the modal
     matches the Tracker Integration wizard without depending on that
     ancestor class. */
  .bulk-import-panel {
    width: min(820px, calc(100vw - 24px));
    padding: var(--spacing-lg);
    position: relative;
  }

  .bulk-import-close {
    position: absolute;
    top: 12px;
    right: 12px;
    width: 32px;
    height: 32px;
    border-radius: var(--radius-full);
    background: var(--color-surface-light);
    color: var(--color-text);
    border: 1px solid var(--color-border);
    font-size: 1.1rem;
    line-height: 1;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
  }

  .bulk-import-close:hover:not(:disabled) {
    background: var(--color-surface-hover);
  }

  .bulk-import-panel :global(h2) {
    color: var(--color-primary);
    margin: 0 0 var(--spacing-sm);
    font-size: 1.5rem;
  }

  .bulk-import-lead {
    color: var(--color-text-secondary);
    margin: 0 0 var(--spacing-md);
    line-height: 1.5;
  }

  .bulk-import-panel :global(.wizard-info) {
    background: rgba(33, 150, 243, 0.1);
    border: 1px solid rgba(33, 150, 243, 0.3);
    border-radius: var(--radius-md);
    padding: var(--spacing-lg);
    margin: var(--spacing-md) 0 var(--spacing-lg);
  }

  .bulk-import-panel :global(.wizard-info h4) {
    color: var(--color-info, #2196f3);
    margin: 0 0 var(--spacing-xs);
    font-size: 0.95rem;
  }

  .bulk-import-panel :global(.wizard-info p) {
    color: var(--color-text-secondary);
    margin: 0;
    line-height: 1.5;
  }

  .bulk-import-seed-row {
    display: grid;
    grid-template-columns: 7fr 3fr;
    gap: var(--spacing-md);
    align-items: flex-end;
    margin: 0;
  }

  .bulk-import-seed-buttons {
    grid-column: 1 / -1;
    display: flex;
    gap: var(--spacing-sm);
    margin-top: var(--spacing-md);
  }

  @media (max-width: 640px) {
    .bulk-import-seed-row {
      grid-template-columns: 1fr;
    }
  }

  .bulk-import-panel :global(.form-group) {
    display: flex;
    flex-direction: column;
    gap: var(--spacing-xs);
    margin-bottom: 0;
    min-width: 0;
  }

  .bulk-import-panel :global(.form-group label) {
    color: var(--color-text);
    font-weight: 600;
    font-size: 0.95rem;
  }

  .bulk-import-panel :global(.form-group input),
  .bulk-import-panel :global(.form-group select) {
    width: 100%;
    padding: 12px 14px;
    background: var(--color-bg-dark);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    color: var(--color-text);
    font-size: 1rem;
    transition: border-color var(--transition-normal), box-shadow var(--transition-normal);
  }

  .bulk-import-panel :global(.form-group input:focus),
  .bulk-import-panel :global(.form-group select:focus) {
    outline: none;
    border-color: var(--color-primary);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-primary) 35%, transparent);
  }

  .bulk-import-panel :global(.form-group select) {
    cursor: pointer;
  }

  .bulk-import-panel :global(.wizard-primary-btn) {
    background: var(--color-primary);
    color: var(--color-bg-dark);
    border: 1px solid var(--color-primary);
    padding: var(--spacing-sm) var(--spacing-lg);
    border-radius: var(--radius-md);
    font-weight: 700;
    cursor: pointer;
    min-height: 38px;
    flex: 1;
    transition: background-color var(--transition-fast), border-color var(--transition-fast), transform var(--transition-fast);
  }

  .bulk-import-panel :global(.wizard-primary-btn:hover:not(:disabled)) {
    background: var(--color-primary-light, var(--color-primary));
    transform: translateY(-1px);
  }

  .bulk-import-panel :global(.wizard-primary-btn:disabled) {
    opacity: 0.55;
    cursor: not-allowed;
    transform: none;
  }

  .bulk-import-panel :global(.wizard-secondary-btn) {
    background: var(--color-surface);
    color: var(--color-text);
    border: 1px solid var(--color-border);
    padding: var(--spacing-sm) var(--spacing-lg);
    border-radius: var(--radius-md);
    font-weight: 500;
    cursor: pointer;
    min-height: 38px;
  }

  .bulk-import-panel :global(.wizard-secondary-btn:hover:not(:disabled)) {
    background: var(--color-surface-hover);
  }

  .bulk-import-panel :global(.modal-buttons) {
    display: flex;
    justify-content: flex-end;
    gap: var(--spacing-sm);
    margin-top: var(--spacing-md);
  }

  /* Override the global wizard-preview-actions which caps width at 620px
     and auto-margins the row; inside our 820px panel that reads as indented. */
  .bulk-import-panel :global(.wizard-preview-actions) {
    display: flex;
    gap: var(--spacing-sm);
    margin: 0 0 var(--spacing-sm);
    max-width: none;
    justify-content: flex-start;
  }

  .bulk-import-panel :global(.bulk-import-list-header),
  .bulk-import-panel :global(.bulk-import-list) {
    max-width: none;
  }

  .bulk-import-panel :global(.wizard-character-item.is-uptodate) {
    opacity: 0.55;
    cursor: not-allowed;
    border-style: dashed;
  }

  .bulk-import-panel :global(.wizard-character-item.is-uptodate:hover) {
    background: inherit;
    border-color: color-mix(in srgb, var(--color-border-light) 56%, var(--color-border));
    box-shadow: none;
  }

  .bulk-import-panel :global(.wizard-character-item.is-uptodate input[type="checkbox"]) {
    cursor: not-allowed;
  }
</style>
