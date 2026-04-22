<script lang="ts">
  import type { AppApi, RosterPayload } from '../../../types/app-api';
  import { onDestroy } from 'svelte';
  import { UIHelper } from '../../utils/uiHelper';
  import { TOAST_TYPES } from '../../legacy/config/constants.js';
  import { BibleApiRequestError, BibleApiService } from '../../services/BibleApiService';
  import { formatCombatPowerDisplay, formatItemLevelDisplay } from '../../utils/formValidator';
  import { notifyRosterChanged, requestManageRoster } from '../../stores/rosterSync';
  import { reportError } from '../../utils/errorHandler';
  import { withAsyncError } from '../../utils/errorWrappers';
  import { ERROR_CODES } from '../../utils/errorCodes';
  import ManualCharacterModal from '../roster/ManualCharacterModal.svelte';

  type Character = {
    name: string;
    class: string;
    ilvl: number;
    combatPower: number | null;
  };

  type PreviewCharacter = Character & {
    selected: boolean;
  };

  type SortField = 'ilvl' | 'combatPower';
  type SortDirection = 'desc' | 'asc';
  type MathiRegion = 'NA' | 'EU';
  type WizardStep = 'welcome' | 'mathimoe' | 'preview';

  export let onRequestClose: (() => void) | undefined = undefined;
  export let onNavigateToRoster: (() => void) | undefined = undefined;

  const FALLBACK_CLASS = 'Berserker';
  const FALLBACK_ILVL = 1500;
  const MATHI_COOLDOWN_MS = 60_000;
  const VALID_CLASSES = new Set([
    'Slayer', 'Valkyrie', 'Berserker', 'Destroyer', 'Gunlancer', 'Paladin', 'Guardian Knight',
    'Glaivier', 'Scrapper', 'Soulfist', 'Wardancer', 'Breaker', 'Striker',
    'Gunslinger', 'Artillerist', 'Deadeye', 'Machinist', 'Sharpshooter',
    'Arcanist', 'Bard', 'Sorceress', 'Summoner',
    'Deathblade', 'Reaper', 'Shadowhunter', 'Souleater',
    'Aeromancer', 'Artist', 'Wildsoul',
  ]);

  const ui = new UIHelper();
  const api: AppApi = window.api;

  let currentStep: WizardStep = 'welcome';

  let loading = false;
  let progressText = '';

  let mathiProgressVisible = false;
  let mathiProgressText = 'Fetching roster from Bible API...';

  let foundCharacters: PreviewCharacter[] = [];
  let sortField: SortField = 'ilvl';
  let sortDirection: SortDirection = 'desc';

  let mathiCharacterName = '';
  let mathiRegion: MathiRegion = 'NA';
  let mathiLoading = false;
  let cooldownRemaining = 0;
  let cooldownTimer: ReturnType<typeof setInterval> | null = null;

  let manualAddModalOpen = false;

  $: selectedCount = foundCharacters.filter((character) => character.selected).length;
  $: importLabel = selectedCount > 0
    ? `Import ${selectedCount} Character${selectedCount > 1 ? 's' : ''}`
    : 'Import Selected';
  $: canSearchMathi = Boolean(mathiCharacterName.trim()) && !loading && !mathiLoading && cooldownRemaining === 0;
  $: mathiButtonLabel = cooldownRemaining > 0
    ? `Wait ${cooldownRemaining}s`
    : (mathiLoading ? 'Fetching roster…' : 'Import');
  $: wizardSortIlvlArrow = sortField === 'ilvl' ? (sortDirection === 'desc' ? '↓' : '↑') : '↕';
  $: wizardSortCpArrow = sortField === 'combatPower' ? (sortDirection === 'desc' ? '↓' : '↑') : '↕';

  onDestroy(() => {
    if (cooldownTimer) {
      clearInterval(cooldownTimer);
      cooldownTimer = null;
    }
  });

  function showToast(message: string, type = TOAST_TYPES.INFO) {
    ui.showToast(message, type);
  }

  function requestModalClose() {
    if (onRequestClose) {
      onRequestClose();
      return;
    }
    window.dispatchEvent(new CustomEvent('wtl-close-modal'));
  }

  function openWelcomeStep() {
    currentStep = 'welcome';
    mathiProgressVisible = false;
  }

  function openMathimoeStep() {
    currentStep = 'mathimoe';
    mathiProgressVisible = false;
    mathiProgressText = 'Fetching roster from Bible API...';
  }

  function openPreviewStep() {
    currentStep = 'preview';
    mathiProgressVisible = false;
  }

  /**
   * Opens the standalone "Add character manually" modal targeting the currently
   * active roster. Previously this navigated the user to the roster page and
   * required a second click on Manage → Manual; the modal removes that friction
   * so users can add a character without leaving Tracker Integration.
   */
  function openManualAddModal() {
    manualAddModalOpen = true;
  }

  function closeManualAddModal() {
    manualAddModalOpen = false;
  }

  /**
   * After adding a character manually, route the user to the Rosters settings
   * screen with a pending Manage request so they land directly on the roster
   * view and can see the new character without extra clicks.
   */
  function handleManualAdded(rosterId: string) {
    requestManageRoster(rosterId);
    window.location.hash = 'settings/rosters';
  }

  /**
   * After a successful Bible import we send the user to the roster view so they
   * can review the newly-imported characters. Falls back to the Rosters
   * settings section when no navigation handler is supplied (standalone wizard
   * modal context).
   */
  function navigateToRosterAfterImport() {
    if (onNavigateToRoster) {
      onNavigateToRoster();
      return;
    }
    window.location.hash = 'settings/rosters';
  }

  function normalizeClass(value: string | null | undefined) {
    const safe = String(value || '').trim();
    return VALID_CLASSES.has(safe) ? safe : FALLBACK_CLASS;
  }

  function normalizeIlvl(value: number | null | undefined) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : FALLBACK_ILVL;
  }

  function normalizeCombatPower(value: number | null | undefined) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }

  function toPreviewCharacter(character: Character): PreviewCharacter {
    return {
      name: String(character.name || '').trim(),
      class: normalizeClass(character.class),
      ilvl: normalizeIlvl(character.ilvl),
      combatPower: normalizeCombatPower(character.combatPower),
      selected: false,
    };
  }

  function updateCooldownLabel(endsAt: number) {
    cooldownRemaining = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
  }

  function startMathiCooldown() {
    const endsAt = Date.now() + MATHI_COOLDOWN_MS;
    if (cooldownTimer) {
      clearInterval(cooldownTimer);
      cooldownTimer = null;
    }

    updateCooldownLabel(endsAt);
    cooldownTimer = setInterval(() => {
      updateCooldownLabel(endsAt);
      if (cooldownRemaining === 0 && cooldownTimer) {
        clearInterval(cooldownTimer);
        cooldownTimer = null;
      }
    }, 1000);
  }

  async function loadPreviewCharacters(rows: Character[], successMessage: string) {
    const normalizedCharacters = rows
      .map((item) => toPreviewCharacter(item))
      .filter((item) => Boolean(item.name));

    foundCharacters = sortPreviewCharacters(normalizedCharacters, sortField, sortDirection);

    if (!foundCharacters.length) {
      showToast('No characters found', TOAST_TYPES.WARNING);
      return;
    }

    showToast(successMessage, TOAST_TYPES.SUCCESS);
    openPreviewStep();
  }

  async function importFromMathiMoe() {
    const trimmedName = mathiCharacterName.trim();
    if (!trimmedName) {
      showToast('Please enter a character name', TOAST_TYPES.ERROR);
      return;
    }

    if (cooldownRemaining > 0) {
      showToast(`Please wait ${cooldownRemaining}s before trying again.`, TOAST_TYPES.WARNING);
      return;
    }

    mathiLoading = true;
    progressText = 'Fetching roster from Bible API...';
    mathiProgressVisible = true;
    mathiProgressText = 'Fetching roster from Bible API...';

    const mathiResult = await withAsyncError(async () => {
      let rows: Awaited<ReturnType<typeof BibleApiService.fetchFullRoster>>;
      try {
        rows = await BibleApiService.fetchFullRoster(mathiRegion, trimmedName);
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

      await loadPreviewCharacters(Array.isArray(rows) ? rows : [], `Preview loaded: ${rows?.length || 0} characters`);
      startMathiCooldown();
      progressText = 'Roster fetched successfully!';
      mathiProgressText = 'Roster fetched successfully!';
      return true;
    }, {
      code: ERROR_CODES.NETWORK.REQUEST_FAILED,
      severity: 'error',
      context: {
        phase: 'importFromMathiMoe',
        action: 'import-from-mathi-moe',
        region: mathiRegion,
        characterName: trimmedName,
      },
      showToast: true,
    });

    if (mathiResult === null) {
      progressText = 'Bible API import failed';
      mathiProgressText = 'Bible API import failed';
    }

    mathiLoading = false;
    if (currentStep !== 'mathimoe') {
      mathiProgressVisible = false;
    }
  }

  function sortPreviewCharacters(items: PreviewCharacter[], field: SortField, direction: SortDirection) {
    const sign = direction === 'desc' ? -1 : 1;
    const sorted = [...items].sort((left, right) => {
      const leftValue = Number(left[field] || 0);
      const rightValue = Number(right[field] || 0);
      if (leftValue === rightValue) {
        return left.name.localeCompare(right.name);
      }
      return leftValue > rightValue ? sign : -sign;
    });
    return sorted;
  }

  function applySort(field: SortField) {
    if (sortField === field) {
      sortDirection = sortDirection === 'desc' ? 'asc' : 'desc';
    } else {
      sortField = field;
      sortDirection = 'desc';
    }

    foundCharacters = sortPreviewCharacters(foundCharacters, field, sortDirection);
  }

  function selectAllCharacters(nextSelected: boolean) {
    foundCharacters = foundCharacters.map((character) => ({
      ...character,
      selected: nextSelected,
    }));
  }

  function toggleCharacterSelection(index: number, nextSelected: boolean) {
    foundCharacters = foundCharacters.map((character, currentIndex) => (
      currentIndex === index ? { ...character, selected: nextSelected } : character
    ));
  }

  function toggleCharacterSelectionFromCard(index: number, event: MouseEvent) {
    const target = event.target;
    if (target instanceof HTMLInputElement) {
      return;
    }

    const current = foundCharacters[index];
    if (!current) {
      return;
    }

    toggleCharacterSelection(index, !current.selected);
  }

  function handleCharacterCardKeydown(index: number, event: KeyboardEvent) {
    if (event.key !== 'Enter' && event.key !== ' ') {
      return;
    }

    event.preventDefault();
    const current = foundCharacters[index];
    if (!current) {
      return;
    }

    toggleCharacterSelection(index, !current.selected);
  }

  function createRosterSnapshot(rosterPayload: RosterPayload | null | undefined) {
    const currentRoster: Record<string, unknown> = {
      ...(rosterPayload?.roster || {}),
    };
    const currentOrder: string[] = Array.isArray(rosterPayload?.order)
      ? [...rosterPayload.order]
      : [];

    return { currentRoster, currentOrder };
  }

  function mergeSelectedCharacters(
    selectedCharacters: PreviewCharacter[],
    currentRoster: Record<string, unknown>,
    currentOrder: string[]
  ) {
    let imported = 0;
    let updated = 0;

    selectedCharacters.forEach((character) => {
      const safeName = String(character.name || '').trim();
      if (!safeName) return;

      const existing = currentRoster[safeName] as Record<string, unknown> | undefined;
      if (existing) {
        currentRoster[safeName] = {
          ...existing,
          class: normalizeClass(character.class),
          ilvl: normalizeIlvl(character.ilvl),
          combatPower: normalizeCombatPower(character.combatPower),
        };
        updated += 1;
        return;
      }

      currentRoster[safeName] = {
        class: normalizeClass(character.class),
        ilvl: normalizeIlvl(character.ilvl),
        visible: true,
        combatPower: normalizeCombatPower(character.combatPower),
      };
      currentOrder.push(safeName);
      imported += 1;
    });

    return { imported, updated };
  }

  async function persistImportedCharacters(activeRosterId: string, payload: { roster: Record<string, unknown>; order: string[] }) {
    await api.saveRoster(activeRosterId, payload);
    notifyRosterChanged();
  }

  async function importSelectedCharacters() {
    const selectedCharacters = foundCharacters.filter((character) => character.selected);
    if (!selectedCharacters.length) {
      showToast('Please select at least one character', TOAST_TYPES.WARNING);
      return;
    }

    const activeRosterId = await api.getActiveRoster();
    if (!activeRosterId) {
      showToast('No active roster selected', TOAST_TYPES.ERROR);
      return;
    }

    loading = true;
    progressText = 'Importing selected characters…';

    const importResult = await withAsyncError(async () => {
      const rosterPayload = await api.loadRoster(activeRosterId);
      const { currentRoster, currentOrder } = createRosterSnapshot(rosterPayload);
      const { imported, updated } = mergeSelectedCharacters(selectedCharacters, currentRoster, currentOrder);

      await persistImportedCharacters(activeRosterId, {
        roster: currentRoster,
        order: currentOrder,
      });

      showToast(`${imported} character${imported !== 1 ? 's' : ''} imported, ${updated} updated`, TOAST_TYPES.SUCCESS);
      progressText = `Imported: ${imported}, Updated: ${updated}`;
      requestModalClose();
      navigateToRosterAfterImport();
      return true;
    }, {
      code: ERROR_CODES.SYNC.SAVE_FAILED,
      severity: 'error',
      context: {
        phase: 'importSelectedCharacters',
        action: 'import-selected-characters',
        rosterId: activeRosterId,
        selectedCount: selectedCharacters.length,
      },
      showToast: true,
    });

    if (importResult === null) {
      progressText = 'Import failed';
    }

    loading = false;
  }
</script>

{#if currentStep === 'welcome'}
  <section id="wizard-tab">
    <button id="wizard-welcome-close" class="close-btn" type="button" aria-label="Close wizard" on:click={requestModalClose}>×</button>
    <h2 id="wizard-title">Welcome to Weekly Tracker LA!</h2>
    <p>To get started, you can import your characters in two ways:</p>

    <div class="wizard-option">
      <h3 class="wizard-option-title-with-icon">
        <img class="wizard-bible-icon" src="./assets/icons/items/bibleicon.png" alt="" aria-hidden="true" draggable="false" />
        <span>Bible API</span>
      </h3>
      <p>Import characters using any character name from your roster.</p>
      <ul>
        <li>Fetches character data from Bible API</li>
        <li>Includes class, item level and combat power</li>
        <li>Only requires one character name</li>
      </ul>
      <button id="wizard-mathimoe-btn" class="wizard-primary-btn" type="button" on:click={openMathimoeStep}>Import from Bible API</button>
    </div>

    <div class="wizard-manual">
      <p>Or add your characters manually:</p>
      <button id="wizard-manual-btn" class="wizard-secondary-btn" type="button" on:click={openManualAddModal}>Add Manually</button>
    </div>
  </section>
{:else if currentStep === 'mathimoe'}
  <section id="wizard-tab">
    <button id="wizard-mathimoe-close" class="close-btn" type="button" aria-label="Close wizard" on:click={requestModalClose}>×</button>
    <h2>Import from Bible API</h2>
    <p>Enter name of <strong>any character</strong> from your roster:</p>

    <div class="wizard-info">
      <h4>💡 Tip:</h4>
      <p>The app fetches all characters associated with this roster.</p>
    </div>

    <div class="form-row wizard-mathimoe-row">
      <div class="form-group form-group-name">
        <label for="wizard-mathimoe-name">Character name:</label>
        <input
          id="wizard-mathimoe-name"
          type="text"
          bind:value={mathiCharacterName}
          placeholder=""
          autocomplete="off"
          on:keydown={(event) => event.key === 'Enter' && canSearchMathi && importFromMathiMoe()}
        />
      </div>

      <div class="form-group form-group-region">
        <label for="wizard-mathimoe-region">Region:</label>
        <select id="wizard-mathimoe-region" bind:value={mathiRegion}>
          <option value="NA">NA</option>
          <option value="EU">EU</option>
        </select>
      </div>
    </div>

    <div id="wizard-mathimoe-progress" class="wizard-progress-container" style={`display: ${mathiProgressVisible || mathiLoading ? 'block' : 'none'};`}>
      <div class="wizard-progress-bar">
        <div id="wizard-mathimoe-progress-fill" class="wizard-progress-fill" style={`width: ${mathiLoading ? '50%' : (mathiProgressVisible ? '100%' : '0%')};`}></div>
      </div>
      <div id="wizard-mathimoe-progress-text" class="wizard-progress-text">{mathiProgressText}</div>
    </div>

    <div class="modal-buttons">
      <button id="wizard-mathimoe-back-btn" class="wizard-secondary-btn" type="button" disabled={mathiLoading} on:click={openWelcomeStep}>Back</button>
      <button id="wizard-mathimoe-search-btn" class="wizard-primary-btn" type="button" disabled={!canSearchMathi} on:click={importFromMathiMoe}>
        <span class="btn-label">{mathiButtonLabel}</span>
      </button>
    </div>
  </section>
{:else}
  <section id="wizard-tab">
    <button id="wizard-preview-close" class="close-btn" type="button" aria-label="Close wizard" on:click={requestModalClose}>×</button>
    <h2>Select Characters</h2>
    <p>Check the characters you want to add to your roster:</p>

    <div class="wizard-preview-actions">
      <button id="wizard-select-all-btn" class="wizard-secondary-btn" type="button" on:click={() => selectAllCharacters(true)} disabled={loading || mathiLoading}>Select All</button>
      <button id="wizard-deselect-all-btn" class="wizard-secondary-btn" type="button" on:click={() => selectAllCharacters(false)} disabled={loading || mathiLoading}>Deselect All</button>
    </div>

    <div class="wizard-character-list-header">
      <div></div>
      <div>Name</div>
      <div>Class</div>
      <button id="wizard-sort-ilvl-btn" class="wizard-sort-header-btn" class:active={sortField === 'ilvl'} title="Sort by Item Level" type="button" on:click={() => applySort('ilvl')}>
        <span>iLvl</span>
        <span class="wizard-sort-arrow">{wizardSortIlvlArrow}</span>
      </button>
      <button id="wizard-sort-cp-btn" class="wizard-sort-header-btn" class:active={sortField === 'combatPower'} title="Sort by Combat Power" type="button" on:click={() => applySort('combatPower')}>
        <span>CP</span>
        <span class="wizard-sort-arrow">{wizardSortCpArrow}</span>
      </button>
    </div>

    <div id="wizard-character-list" class="wizard-character-list">
      {#each foundCharacters as character, index (`${character.name}-${index}`)}
        <div
          class="wizard-character-item"
          role="button"
          tabindex="0"
          aria-label={`Character ${character.name}`}
          aria-pressed={character.selected}
          on:click={(event) => toggleCharacterSelectionFromCard(index, event)}
          on:keydown={(event) => handleCharacterCardKeydown(index, event)}
        >
          <input
            type="checkbox"
            checked={character.selected}
            on:click|stopPropagation
            on:change={(event) => toggleCharacterSelection(index, Boolean((event.currentTarget as HTMLInputElement).checked))}
            aria-label={`Select ${character.name}`}
          />
          <div class="wizard-character-info">
            <div class="wizard-character-name">{character.name}</div>
            <div class="wizard-character-class">{character.class}</div>
            <div class="wizard-character-ilvl">iLvl: {formatItemLevelDisplay(character.ilvl)}</div>
            <div class="wizard-character-cp">CP: {formatCombatPowerDisplay(character.combatPower)}</div>
          </div>
        </div>
      {/each}
    </div>

    <div class="modal-buttons">
      <button id="wizard-preview-back-btn" class="wizard-secondary-btn" type="button" on:click={openMathimoeStep}>Back</button>
      <button id="wizard-preview-import-btn" class="wizard-primary-btn" type="button" disabled={!selectedCount || loading || mathiLoading} on:click={importSelectedCharacters}>{importLabel}</button>
    </div>
  </section>
{/if}

<ManualCharacterModal
  open={manualAddModalOpen}
  onClose={closeManualAddModal}
  onAfterAdd={handleManualAdded}
/>
