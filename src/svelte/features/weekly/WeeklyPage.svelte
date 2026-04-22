<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import { UIHelper } from '../../utils/uiHelper';
  import { notifyRosterChanged, rosterChangeVersion, visibleRostersChangeVersion } from '../../stores/rosterSync';
  import type { AppApi, DbAccessSupport, SettingsPayload, RosterPayload } from '../../../types/app-api';
  import {
    BOSSES,
    BOSS_MAP,
    CLASS_ICONS,
    RAID_CONFIG,
    DAILY_RESET,
    TOAST_TYPES,
  } from '../../legacy/config/constants.js';
  import { normalizeRaidKey } from '../../domain/shared/raidDomain';
  import { isCharacterEligibleForRaid } from '../../domain/shared/raidDomain';
  import { formatItemLevelDisplay } from '../../utils/formValidator';
  import { reportError } from '../../utils/errorHandler';
  import { ERROR_CODES } from '../../utils/errorCodes';
  import { FriendsRosterService } from '../friends/services/FriendsRosterService';
  import { normalizeFriendsConfig } from '../friends/config';
  import type { FriendsRosterConfig } from '../friends/types';
  import { runAutoRaidFocusUpdate } from '../../services/AutoRaidFocusUpdateService';
  import { BibleApiRequestError, BibleApiService } from '../../services/BibleApiService';
  import { applyRefreshToExisting } from '../roster/rosterDomain';
  import { withAsyncError } from '../../utils/errorWrappers';
  import {
    loadColumns,
    loadValues,
    saveValues,
    getCellValue,
    setCellValue,
    orderedColumns,
  } from '../custom/customTabDomain';
  import type { CustomColumnsState, CustomTabValues, CustomColumn } from '../custom/customTabDomain';

  type Difficulty = 'Solo' | 'Normal' | 'Hard' | 'Nightmare';

  type RosterCharacter = {
    class: string;
    ilvl: number;
    visible?: boolean;
    combatPower?: number | null;
  };

  type RaidCell = {
    cleared: boolean;
    difficulty: Difficulty;
    hidden: boolean;
    chestOpened: boolean;
    chestOpenCount: number;
    timestamp: string | null;
  };

  type CharacterBossData = Record<string, RaidCell> & { _extraGold?: number };
  type CharacterDataMap = Record<string, CharacterBossData>;

  type DailyActivity = {
    completed: boolean;
    boss: string | null;
    timestamp: string | null;
  };

  type DailyData = {
    date: string;
    characters: Record<string, { guardianRaid: DailyActivity; chaosDungeon: DailyActivity }>;
    roster: { fieldBoss: DailyActivity; chaosGate: DailyActivity; thaemine?: DailyActivity };
  };

  type DailyPeriod = {
    startMs: number;
    endMs: number;
    startIso: string;
  };

  type WeeklyConfirmAction = 'reset-weekly' | null;

  type WeeklyCardSnapshot = {
    rosterId: string;
    rosterName: string;
    roster: Record<string, RosterCharacter | unknown>;
    order: string[];
    characterData: CharacterDataMap;
    dailyData: DailyData | null;
    hiddenColumns: string[];
    isActive: boolean;
  };

  const api: AppApi = window.api;
  const ui = new UIHelper();
  const WEEKLY_DEBUG_ENABLED = false;
  const AUTO_RAID_FOCUS_DEDUP_MS = 1200;
  const API_READY_TIMEOUT_MS = 6000;
  const MIN_FRIENDS_PIN_LENGTH = 4;

  const DEFAULT_RAID_CELL: RaidCell = {
    cleared: false,
    difficulty: 'Solo',
    hidden: false,
    chestOpened: false,
    chestOpenCount: 0,
    timestamp: null,
  };

  const DOUBLE_CHEST_RAID_IDS = new Set(['aegir', 'brel', 'mordum', 'armoche']);

  // Bible API refresh shared between the Weekly Tracker per-roster Refresh
  // button and the one living in Roster Management — same 1 minute cooldown
  // so users can't hammer the endpoint from either surface.
  const WEEKLY_REFRESH_COOLDOWN_MS = 60_000;
  const WEEKLY_REFRESH_REGION = 'NA' as const;

  let loading = false;
  let activeRosterId = '';
  let roster: Record<string, RosterCharacter | unknown> = {};
  let order: string[] = [];
  let characterData: CharacterDataMap = {};
  let timerText = 'Weekly Reset: --:--:--';
  let timerInterval: ReturnType<typeof setInterval> | null = null;
  let dailyData: DailyData | null = null;
  let visibleCharacters: string[] = [];
  let unsubscribeRosterChanges: (() => void) | null = null;
  let unsubscribeVisibleRosterChanges: (() => void) | null = null;
  let lastDebugSignature = '';
  let hiddenColumns: string[] = [];
  let columnSettingsOpen = false;
  let draftVisibleColumns: Record<string, boolean> = {};
  let columnSettingsRosterId = '';
  let columnSettingsRosterName = '';
  let goldPopoverTarget: { rosterId: string; characterName: string } | null = null;
  let goldBonusInput = '';
  let goldBonusInputRef: HTMLInputElement | null = null;
  let draggingCharacterName: string | null = null;
  let dragOverCharacterName: string | null = null;
  let dailyResetCheckedForPeriod = '';
  let settings: SettingsPayload | null = null;
  let dbAccessSupport: DbAccessSupport = {
    persistentHandle: typeof window !== 'undefined' && typeof window.showOpenFilePicker === 'function',
    nativeFilePicker: typeof window !== 'undefined' && typeof window.showOpenFilePicker === 'function',
    handleDragDrop: typeof DataTransferItem !== 'undefined' && 'getAsFileSystemHandle' in DataTransferItem.prototype,
    browser: 'unknown',
  };
  let lastAutoRaidFocusTriggerAt = 0;
  let isAutoRaidFocusUpdateInFlight = false;
  let visibleRosterIds: string[] = [];
  let rosterNamesById: Record<string, string> = {};
  let rosterCardsCache: Record<string, WeeklyCardSnapshot> = {};
  let weeklyCards: WeeklyCardSnapshot[] = [];
  let apiReadyStatus: 'pending' | 'ready' | 'timeout' | 'error' = 'pending';
  let lastComputedCardsCount = 0;
  let debugSnapshot: Record<string, unknown> = {
    stage: 'init',
    timestamp: new Date().toISOString(),
  };
  let weeklyConfirmAction: WeeklyConfirmAction = null;
  let weeklyConfirmRosterId = '';
  let weeklyConfirmRosterName = '';
  let weeklyConfirmCancelButton: HTMLButtonElement | null = null;
  let weeklyConfirmConfirmButton: HTMLButtonElement | null = null;
  let weeklyConfirmReturnFocusEl: HTMLElement | null = null;

  // Custom tab columns surfaced in the weekly tracker
  let customColumnsStateByRoster: Record<string, CustomColumnsState> = {};
  let customTabValuesCache: Record<string, CustomTabValues> = {};
  let pinnedCustomColsByRoster: Record<string, string[]> = {};
  let draftPinnedCustomCols: Record<string, boolean> = {};
  let customColWidthsByRoster: Record<string, Record<string, number>> = {};
  let editingWidthColId: string | null = null;
  let editingWidthRosterId: string | null = null;
  let editingWidthDraft = 5;

  // Refresh-from-Bible state, keyed by rosterId. `refreshingRosterIds` gates
  // the spinner/label, `refreshCooldownByRoster` holds the seconds remaining
  // for UI display; a single interval drives the countdown for every active
  // cooldown at once.
  let refreshingRosterIds: Record<string, boolean> = {};
  let refreshCooldownByRoster: Record<string, number> = {};
  let refreshCooldownEndsByRoster: Record<string, number> = {};
  let refreshCooldownTimer: ReturnType<typeof setInterval> | null = null;

  $: weeklyConfirmOpen = weeklyConfirmAction !== null;
  $: weeklyConfirmTitle = weeklyConfirmAction === 'reset-weekly' ? 'Reset weekly data' : '';
  $: weeklyConfirmMessage = weeklyConfirmAction === 'reset-weekly'
    ? `Reset weekly and daily progress for all visible characters in ${weeklyConfirmRosterName || 'this roster'}?`
    : '';
  async function openWeeklyConfirm(
    action: Exclude<WeeklyConfirmAction, null>,
    rosterId = activeRosterId,
    rosterName = ''
  ) {
    weeklyConfirmReturnFocusEl = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    weeklyConfirmAction = action;
    weeklyConfirmRosterId = String(rosterId || '').trim();
    weeklyConfirmRosterName = String(rosterName || '').trim() || rosterNamesById[weeklyConfirmRosterId] || 'this roster';
    await tick();
    weeklyConfirmConfirmButton?.focus();
  }

  function closeWeeklyConfirm() {
    weeklyConfirmAction = null;
    weeklyConfirmRosterId = '';
    weeklyConfirmRosterName = '';
    const returnFocusEl = weeklyConfirmReturnFocusEl;
    weeklyConfirmReturnFocusEl = null;
    if (returnFocusEl && typeof returnFocusEl.focus === 'function') {
      returnFocusEl.focus();
    }
  }

  function onWeeklyConfirmOverlayClick(event: MouseEvent) {
    if (event.target === event.currentTarget) {
      closeWeeklyConfirm();
    }
  }

  function onWeeklyConfirmOverlayKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeWeeklyConfirm();
      return;
    }

    if (event.key === 'Tab') {
      const focusables = [weeklyConfirmCancelButton, weeklyConfirmConfirmButton].filter(Boolean) as HTMLButtonElement[];
      if (focusables.length === 0) {
        return;
      }

      const currentIndex = focusables.findIndex((entry) => entry === document.activeElement);
      if (event.shiftKey) {
        event.preventDefault();
        const nextIndex = currentIndex <= 0 ? focusables.length - 1 : currentIndex - 1;
        focusables[nextIndex]?.focus();
      } else {
        event.preventDefault();
        const nextIndex = currentIndex === -1 || currentIndex === focusables.length - 1 ? 0 : currentIndex + 1;
        focusables[nextIndex]?.focus();
      }
    }
  }

  async function confirmWeeklyAction() {
    if (weeklyConfirmAction !== 'reset-weekly') {
      return;
    }
    await resetWeeklyForRoster(weeklyConfirmRosterId || activeRosterId);
    closeWeeklyConfirm();
  }

  function tickRefreshCooldowns() {
    const now = Date.now();
    const nextCooldowns: Record<string, number> = {};
    const nextEndsBy: Record<string, number> = {};
    let anyActive = false;

    for (const [rosterId, endsAt] of Object.entries(refreshCooldownEndsByRoster)) {
      const remainingMs = endsAt - now;
      if (remainingMs <= 0) continue;
      nextCooldowns[rosterId] = Math.ceil(remainingMs / 1000);
      nextEndsBy[rosterId] = endsAt;
      anyActive = true;
    }

    refreshCooldownByRoster = nextCooldowns;
    refreshCooldownEndsByRoster = nextEndsBy;

    if (!anyActive && refreshCooldownTimer) {
      clearInterval(refreshCooldownTimer);
      refreshCooldownTimer = null;
    }
  }

  function startRefreshCooldown(rosterId: string) {
    const endsAt = Date.now() + WEEKLY_REFRESH_COOLDOWN_MS;
    refreshCooldownEndsByRoster = { ...refreshCooldownEndsByRoster, [rosterId]: endsAt };
    refreshCooldownByRoster = {
      ...refreshCooldownByRoster,
      [rosterId]: Math.ceil(WEEKLY_REFRESH_COOLDOWN_MS / 1000),
    };
    if (!refreshCooldownTimer) {
      refreshCooldownTimer = setInterval(tickRefreshCooldowns, 1000);
    }
  }

  function setRefreshing(rosterId: string, value: boolean) {
    if (value) {
      refreshingRosterIds = { ...refreshingRosterIds, [rosterId]: true };
    } else {
      const { [rosterId]: _removed, ...rest } = refreshingRosterIds;
      void _removed;
      refreshingRosterIds = rest;
    }
  }

  /**
   * Refreshes the given roster's characters from the Bible API, mirroring the
   * flow in Roster Management. The first character of the roster is used as
   * the lookup seed (same as Roster Management), results are merged into the
   * existing roster via {@link applyRefreshToExisting}, and a one-minute
   * cooldown is started regardless of outcome to match the other entry point.
   */
  async function handleRefreshWeeklyRoster(rosterId: string) {
    if (!rosterId) return;
    if (refreshingRosterIds[rosterId]) return;
    const remaining = refreshCooldownByRoster[rosterId] || 0;
    if (remaining > 0) {
      showToast(`Please wait ${remaining}s before refreshing again.`, TOAST_TYPES.WARNING);
      return;
    }

    const card = weeklyCards.find((entry) => entry.rosterId === rosterId);
    const firstCharacterName = card?.order?.[0] || '';
    if (!card || !firstCharacterName) {
      showToast('No characters to refresh. Add characters first.', TOAST_TYPES.WARNING);
      return;
    }

    setRefreshing(rosterId, true);
    startRefreshCooldown(rosterId);

    await withAsyncError(async () => {
      let apiCharacters: Awaited<ReturnType<typeof BibleApiService.fetchFullRoster>>;
      try {
        apiCharacters = await BibleApiService.fetchFullRoster(WEEKLY_REFRESH_REGION, firstCharacterName);
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

      if (!Array.isArray(apiCharacters) || apiCharacters.length === 0) {
        showToast('No characters found on Bible API', TOAST_TYPES.ERROR);
        return true;
      }

      const next = applyRefreshToExisting(card.roster as Record<string, unknown>, apiCharacters);
      await api.saveRoster?.(rosterId, { roster: next.roster, order: [...card.order] } as RosterPayload);
      notifyRosterChanged();
      showToast(
        `Successfully refreshed ${next.updatedCount} character${next.updatedCount !== 1 ? 's' : ''} from Bible API!`,
        TOAST_TYPES.SUCCESS,
      );
      return true;
    }, {
      code: ERROR_CODES.NETWORK.REQUEST_FAILED,
      severity: 'error',
      context: {
        phase: 'handleRefreshWeeklyRoster',
        action: 'refresh-roster-from-api',
        rosterId,
        region: WEEKLY_REFRESH_REGION,
      },
      showToast: true,
    });

    setRefreshing(rosterId, false);
  }


  const columnEntries = [
    ...RAID_CONFIG.map((raid) => ({
      id: String(raid.id),
      label: String(raid.label || raid.id),
      subtitle: raid.nmr
        ? `iLvl ${raid.nm} NM / ${raid.hm} HM / ${raid.nmr} Nightmare`
        : `iLvl ${raid.nm} NM / ${raid.hm} HM`,
    })),
    { id: 'gold', label: 'Gold', subtitle: 'Show gold totals column' },
    { id: 'guardianRaid', label: 'Guardian Raid', subtitle: 'Daily checkbox' },
    { id: 'chaosDungeon', label: 'Chaos Dungeon', subtitle: 'Daily checkbox' },
  ];
  const VALID_COLUMN_IDS = new Set(columnEntries.map((entry) => entry.id));

  // --- Custom columns in weekly tracker helpers ---

  function pinnedCustomColsKey(rosterId: string): string {
    return `wtl:weekly:${rosterId}:custom-cols`;
  }

  function loadPinnedCustomCols(rosterId: string): string[] {
    try {
      const raw = localStorage.getItem(pinnedCustomColsKey(rosterId));
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as string[]) : [];
    } catch { return []; }
  }

  function savePinnedCustomCols(rosterId: string, ids: string[]): void {
    try {
      localStorage.setItem(pinnedCustomColsKey(rosterId), JSON.stringify(ids));
    } catch { /* storage unavailable */ }
  }

  function customColWidthsKey(rosterId: string): string {
    return `wtl:weekly:${rosterId}:custom-col-widths`;
  }

  function loadCustomColWidths(rosterId: string): Record<string, number> {
    try {
      const raw = localStorage.getItem(customColWidthsKey(rosterId));
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed as Record<string, number> : {};
    } catch { return {}; }
  }

  function saveCustomColWidths(rosterId: string, widths: Record<string, number>): void {
    try {
      localStorage.setItem(customColWidthsKey(rosterId), JSON.stringify(widths));
    } catch { /* storage unavailable */ }
  }

  function getColWidth(rosterId: string, colId: string): number {
    return customColWidthsByRoster[rosterId]?.[colId] ?? 5;
  }

  function openWidthEditor(rosterId: string, colId: string, currentWidth: number) {
    editingWidthRosterId = rosterId;
    editingWidthColId = colId;
    editingWidthDraft = currentWidth;
  }

  function commitWidthEdit() {
    if (!editingWidthRosterId || !editingWidthColId) return;
    const clamped = Math.max(3, Math.min(14, editingWidthDraft));
    const current = customColWidthsByRoster[editingWidthRosterId] ?? {};
    const next = { ...current, [editingWidthColId]: clamped };
    customColWidthsByRoster = { ...customColWidthsByRoster, [editingWidthRosterId]: next };
    saveCustomColWidths(editingWidthRosterId, next);
    editingWidthColId = null;
    editingWidthRosterId = null;
  }

  function cancelWidthEdit() {
    editingWidthColId = null;
    editingWidthRosterId = null;
  }

  function focusOnMount(node: HTMLElement) {
    node.focus();
  }

  function refreshCustomColumnsForCards(cards: WeeklyCardSnapshot[]) {
    const nextCols: Record<string, CustomColumnsState> = { ...customColumnsStateByRoster };
    const nextPinned: Record<string, string[]> = { ...pinnedCustomColsByRoster };
    const nextValues: Record<string, CustomTabValues> = { ...customTabValuesCache };
    const nextWidths: Record<string, Record<string, number>> = { ...customColWidthsByRoster };
    let changed = false;
    for (const card of cards) {
      if (!nextCols[card.rosterId]) {
        nextCols[card.rosterId] = loadColumns(card.rosterId);
        changed = true;
      }
      if (!nextPinned[card.rosterId]) {
        nextPinned[card.rosterId] = loadPinnedCustomCols(card.rosterId);
        changed = true;
      }
      if (!nextValues[card.rosterId]) {
        nextValues[card.rosterId] = loadValues(card.rosterId);
        changed = true;
      }
      if (!nextWidths[card.rosterId]) {
        nextWidths[card.rosterId] = loadCustomColWidths(card.rosterId);
        changed = true;
      }
    }
    if (changed) {
      customColumnsStateByRoster = nextCols;
      pinnedCustomColsByRoster = nextPinned;
      customTabValuesCache = nextValues;
      customColWidthsByRoster = nextWidths;
    }
  }

  function setWeeklyCustomCellValue(rosterId: string, column: CustomColumn, characterName: string, value: unknown): void {
    const current = customTabValuesCache[rosterId] ?? { perCharacter: {}, global: {} };
    const next = setCellValue(current, column, characterName, value);
    saveValues(rosterId, next);
    customTabValuesCache = { ...customTabValuesCache, [rosterId]: next };
  }

  function toggleDraftPinnedCustomCol(colId: string, checked: boolean): void {
    draftPinnedCustomCols = { ...draftPinnedCustomCols, [colId]: checked };
  }

  $: visibleCharacters = getVisibleCharacters(roster, order);
  $: hiddenSet = new Set(hiddenColumns);
  $: weeklyCards = buildWeeklyCardsFromState(
    activeRosterId,
    visibleRosterIds,
    rosterNamesById,
    rosterCardsCache,
    roster,
    order,
    characterData,
    dailyData,
    hiddenColumns
  );
  $: refreshCustomColumnsForCards(weeklyCards);

  function debugWeekly(step: string, payload?: Record<string, unknown>) {
    if (!WEEKLY_DEBUG_ENABLED) {
      return;
    }

    const info = payload || {};
    console.log(`[WeeklyDebug] ${step}`, info);
    void api.logDebug?.(`[WeeklyDebug] ${step}`, info);
  }

  function updateDebugSnapshot(stage: string, extra: Record<string, unknown> = {}) {
    debugSnapshot = {
      stage,
      timestamp: new Date().toISOString(),
      apiReadyStatus,
      loading,
      activeRosterId,
      visibleRosterIds: [...visibleRosterIds],
      weeklyCardsCount: weeklyCards.length,
      lastComputedCardsCount,
      rosterKeyCount: Object.keys(roster || {}).filter((name) => name !== 'dailyData').length,
      orderCount: order.length,
      hiddenColumns: [...hiddenColumns],
      ...extra,
    };

    (window as Window & { __WTL_weeklyDebug?: Record<string, unknown> }).__WTL_weeklyDebug = debugSnapshot;
  }

  async function copyWeeklyDebugSnapshot() {
    try {
      await navigator.clipboard.writeText(JSON.stringify(debugSnapshot, null, 2));
      showToast('Weekly debug copied to clipboard', TOAST_TYPES.SUCCESS);
    } catch (error) {
      await reportError(error, {
        code: ERROR_CODES.WEEKLY.DEBUG_COPY_FAILED,
        severity: 'warning',
        context: {
          phase: 'copyWeeklyDebugSnapshot',
          action: 'copy-weekly-debug-snapshot',
          rosterId: activeRosterId,
        },
        showToast: false,
      });
      showToast('Failed to copy weekly debug snapshot', TOAST_TYPES.ERROR);
    }
  }

  function debugWeeklyState(step: string) {
    if (!WEEKLY_DEBUG_ENABLED) {
      return;
    }

    const rosterNames = Object.keys(roster || {}).filter((name) => name !== 'dailyData');
    const signature = JSON.stringify({
      activeRosterId,
      rosterCount: rosterNames.length,
      orderCount: order.length,
      visibleCount: visibleCharacters.length,
    });

    if (signature === lastDebugSignature) {
      return;
    }

    lastDebugSignature = signature;
    debugWeekly(step, {
      activeRosterId,
      rosterNames,
      order,
      visibleCharacters,
    });
  }

  async function waitForApiReadyWithTimeout() {
    updateDebugSnapshot('api-ready:waiting');
    try {
      await Promise.race([
        window.__API_READY__,
        new Promise<void>((resolve) => {
          window.setTimeout(() => {
            apiReadyStatus = 'timeout';
            resolve();
          }, API_READY_TIMEOUT_MS);
        }),
      ]);

      if (apiReadyStatus !== 'timeout') {
        apiReadyStatus = 'ready';
        updateDebugSnapshot('api-ready:resolved');
      } else {
        await reportError(new Error('Timed out waiting for __API_READY__'), {
          code: ERROR_CODES.WEEKLY.API_READY_TIMEOUT,
          severity: 'warning',
          context: { timeoutMs: API_READY_TIMEOUT_MS },
          showToast: true,
        });
        updateDebugSnapshot('api-ready:timeout');
      }
    } catch (error) {
      apiReadyStatus = 'error';
      await reportError(error, {
        code: ERROR_CODES.WEEKLY.API_READY_FAILED,
        severity: 'error',
        context: {
          phase: 'waitForApiReadyWithTimeout',
          action: 'wait-api-ready',
          timeoutMs: API_READY_TIMEOUT_MS,
        },
        showToast: false,
      });
      updateDebugSnapshot('api-ready:error', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  onMount(async () => {
    debugWeekly('onMount:start');
    await waitForApiReadyWithTimeout();
    debugWeekly('onMount:api-ready', { apiReadyStatus });
    await loadAll();
    startTimer();

    let isInitialRosterSync = true;
    unsubscribeRosterChanges = rosterChangeVersion.subscribe(() => {
      if (isInitialRosterSync) {
        isInitialRosterSync = false;
        return;
      }
      debugWeekly('sync:rosterChangeVersion');
      handleRosterChanged();
    });

    let isInitialVisibleRosterSync = true;
    unsubscribeVisibleRosterChanges = visibleRostersChangeVersion.subscribe(() => {
      if (isInitialVisibleRosterSync) {
        isInitialVisibleRosterSync = false;
        return;
      }
      debugWeekly('sync:visibleRostersChangeVersion');
      handleRosterChanged();
    });

    document.addEventListener('click', handleGlobalClick);
    document.addEventListener('keydown', handleGlobalKeydown);
    document.addEventListener('visibilitychange', handleVisibilityChangeForAutoRaid);
    document.addEventListener('settingsChanged', handleSettingsChanged as EventListener);
  });

  onDestroy(() => {
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
    if (refreshCooldownTimer) {
      clearInterval(refreshCooldownTimer);
      refreshCooldownTimer = null;
    }
    unsubscribeRosterChanges?.();
    unsubscribeRosterChanges = null;
    unsubscribeVisibleRosterChanges?.();
    unsubscribeVisibleRosterChanges = null;
    document.removeEventListener('click', handleGlobalClick);
    document.removeEventListener('keydown', handleGlobalKeydown);
    document.removeEventListener('visibilitychange', handleVisibilityChangeForAutoRaid);
    document.removeEventListener('settingsChanged', handleSettingsChanged as EventListener);
  });

  function handleGlobalClick(event: MouseEvent) {
    if (!goldPopoverTarget) return;
    const target = event.target as HTMLElement | null;
    if (!target) return;
    if (target.closest('.gold-cell')) return;
    goldPopoverTarget = null;
  }

  function handleGlobalKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      goldPopoverTarget = null;
      closeColumnsConfig();
    }
  }

  function showToast(message: string, type = TOAST_TYPES.INFO) {
    ui.showToast(message, type);
  }

  async function refreshSettingsSnapshot() {
    try {
      const loaded = await api.loadSettings?.();
      if (loaded && typeof loaded === 'object') {
        settings = {
          ...(settings || {}),
          ...(loaded as SettingsPayload),
        } as SettingsPayload;
      }
    } catch (error) {
      await reportError(error, {
        code: ERROR_CODES.WEEKLY.SETTINGS_REFRESH_FAILED,
        severity: 'warning',
        context: {
          phase: 'refreshSettingsSnapshot',
          action: 'refresh-settings-snapshot',
          rosterId: activeRosterId,
        },
        showToast: false,
      });
    }
  }

  async function refreshDbAccessSupport() {
    if (!api.getDatabaseAccessSupport) return;
    dbAccessSupport = await api.getDatabaseAccessSupport();
  }

  function handleSettingsChanged(event: Event) {
    const customEvent = event as CustomEvent<{ settings?: SettingsPayload }>;
    const nextSettings = customEvent?.detail?.settings;
    if (nextSettings && typeof nextSettings === 'object') {
      const previousVisibleLegacy = Array.isArray(settings?.visibleWeeklyRosters)
        ? [...(settings?.visibleWeeklyRosters as string[])]
        : [];
      const previousVisibleByRoster = JSON.stringify(settings?.visibleWeeklyRostersByRoster || {});

      settings = {
        ...(settings || {}),
        ...nextSettings,
      } as SettingsPayload;

      const nextVisibleLegacy = Array.isArray(settings?.visibleWeeklyRosters)
        ? [...(settings?.visibleWeeklyRosters as string[])]
        : [];
      const nextVisibleByRoster = JSON.stringify(settings?.visibleWeeklyRostersByRoster || {});

      if (
        previousVisibleByRoster !== nextVisibleByRoster ||
        JSON.stringify(previousVisibleLegacy) !== JSON.stringify(nextVisibleLegacy)
      ) {
        void loadAll();
      }

      return;
    }

    void refreshSettingsSnapshot();
  }

  function isAutoRaidOnFocusEnabled() {
    if (!settings) return false;

    const rawValue = (settings as Record<string, unknown>).autoRaidUpdateOnFocus;
    if (rawValue === true || rawValue === 'true' || rawValue === 1) {
      return true;
    }

    if (rawValue === false || rawValue === 'false' || rawValue === 0) {
      return false;
    }

    return false;
  }

  async function triggerAutoRaidFocusUpdate() {
    if (!isAutoRaidOnFocusEnabled()) {
      return;
    }

    if (isAutoRaidFocusUpdateInFlight) {
      return;
    }

    if (loading) {
      return;
    }

    const now = Date.now();
    if ((now - lastAutoRaidFocusTriggerAt) < AUTO_RAID_FOCUS_DEDUP_MS) {
      return;
    }

    lastAutoRaidFocusTriggerAt = now;
    isAutoRaidFocusUpdateInFlight = true;

    try {
      const targetRosterIds = Array.from(new Set([
        String(activeRosterId || '').trim(),
        ...(visibleRosterIds || []).map((id) => String(id || '').trim()),
      ].filter((id) => Boolean(id))));

      debugWeekly('auto-raid-focus:update-targets', {
        activeRosterId,
        visibleRosterIds,
        targetRosterIds,
      });

      if (targetRosterIds.length === 0) {
        return;
      }

      await runAutoRaidFocusUpdate(api, ((settings || {}) as Record<string, unknown>), {
        targetRosterIds,
        updateRoster: async ({ rosterId }) => {
          return loadFromDatabase({
            silent: true,
            overlay: false,
            rosterId,
          });
        },
        onRosterSuccess: (rosterId, updatedCells) => {
          debugWeekly('auto-raid-focus:update-roster-success', {
            rosterId,
            updatedCells,
          });
        },
        onRosterFailed: (rosterId, error) => {
          debugWeekly('auto-raid-focus:update-roster-failed', {
            rosterId,
            error: error instanceof Error ? error.message : String(error),
          });
        },
      });

      debugWeekly('auto-raid-focus:update-finished', {
        targetRosterIds,
      });
    } finally {
      isAutoRaidFocusUpdateInFlight = false;
    }
  }

  function getFriendsConfigFromSettings(): FriendsRosterConfig {
    const settingsNow = (settings || {}) as Record<string, unknown>;
    return normalizeFriendsConfig(settingsNow.friendsRoster);
  }

  function resolveSelfPinForRoster(config: FriendsRosterConfig, rosterId: string) {
    const safeRosterId = String(rosterId || '').trim();
    if (!safeRosterId) return '';

    const ownFriendEntry = (config.friends || []).find((friend) => String(friend?.rosterCode || '').trim() === safeRosterId);
    if (ownFriendEntry?.pin) {
      return String(ownFriendEntry.pin || '').trim();
    }

    const byRoster = config.selfPinsByRoster || {};
    return String(byRoster[safeRosterId] || '').trim();
  }

  function getHiddenRaidIdsForCurrentRoster() {
    return (hiddenColumns || [])
      .map((value) => normalizeRaidBossId(String(value || '')))
      .filter((value): value is string => Boolean(value));
  }

  async function tryAutoUploadOnFocusChange() {
    try {
      const friendsConfig = getFriendsConfigFromSettings();
      const activeRosterCode = String(activeRosterId || '').trim();
      if (!activeRosterCode) {
        return;
      }

      const pin = resolveSelfPinForRoster(friendsConfig, activeRosterCode);
      if (pin.length < MIN_FRIENDS_PIN_LENGTH) {
        debugWeekly('friends:auto-upload-focus-skip-pin-missing', {
          activeRosterCode,
          pinLength: pin.length,
        });
        return;
      }

      const rosterSummaries = Object.entries(rosterNamesById || {})
        .map(([id, name]) => ({ id, name: String(name || '').trim() || 'Main Roster' }))
        .filter((entry) => Boolean(entry.id));

      const friendsService = new FriendsRosterService(
        {
          characterData,
          getBosses: () => [...(BOSSES as string[])],
          getHiddenRaidIds: () => getHiddenRaidIdsForCurrentRoster(),
          isCharacterEligible: (ilvl: number, bossId: string) => isCharacterEligibleForRaid(ilvl, bossId, RAID_CONFIG as Array<any>),
        },
        {
          roster,
          rosterOrder: order,
        },
        {
          get: (key: string) => (key === 'settings' ? settings : undefined),
          getActiveRosterId: () => activeRosterCode,
          multiRosterManager: {
            getRosters: () => rosterSummaries,
          },
        }
      );

      if (!friendsService.isConfigured()) {
        debugWeekly('friends:auto-upload-focus-skip-not-configured');
        return;
      }

      const snapshot = friendsService.buildSelfSnapshot();
      const pinHash = await friendsService.hashPin(pin);
      const fingerprint = friendsService.buildSyncFingerprint(snapshot, pinHash);
      const lastFingerprint = friendsConfig.lastUploadFingerprintByRoster?.[activeRosterCode];

      if (lastFingerprint && lastFingerprint === fingerprint) {
        debugWeekly('friends:auto-upload-focus-skip-no-changes', { activeRosterCode });
        return;
      }

      const result = await friendsService.uploadSelfWeekly(pin);

      const nextFriendsConfig: FriendsRosterConfig = {
        ...friendsConfig,
        lastUploadFingerprintByRoster: {
          ...(friendsConfig.lastUploadFingerprintByRoster || {}),
          [activeRosterCode]: result.fingerprint,
        },
      };

      const nextSettings: SettingsPayload = {
        ...((settings || {}) as SettingsPayload),
        friendsRoster: nextFriendsConfig,
      };

      await api.saveSettings?.(nextSettings);
      settings = nextSettings;

      if (result.skipped) {
        debugWeekly('friends:auto-upload-focus-skip-server', {
          activeRosterCode,
          uploaded: result.uploaded,
        });
      } else {
        showToast(`Focus upload completed (${result.uploaded} characters).`, TOAST_TYPES.SUCCESS);
      }

      debugWeekly('friends:auto-upload-focus-success', {
        activeRosterCode,
        uploaded: result.uploaded,
      });
    } catch (error: any) {
      const reported = await reportError(error, {
        code: ERROR_CODES.FRIENDS.AUTO_UPLOAD_FAILED,
        severity: 'warning',
        context: {
          phase: 'tryAutoUploadAfterRaidFocusUpdate',
          action: 'auto-upload-after-raid-focus-update',
          rosterId: activeRosterId,
        },
        showToast: false,
      });
      debugWeekly('friends:auto-upload-focus-failed', {
        message: reported.message,
      });
    }
  }

  async function handleVisibilityChangeForAutoRaid() {
    if (document.visibilityState !== 'visible') {
      return;
    }

    await refreshSettingsSnapshot();

    await triggerAutoRaidFocusUpdate();
    await tryAutoUploadOnFocusChange();
  }

  function sanitizeHiddenColumns(values: unknown): string[] {
    if (!Array.isArray(values)) {
      return [];
    }

    const normalized = values
      .map((entry) => String(entry || '').trim())
      .filter((entry) => Boolean(entry) && VALID_COLUMN_IDS.has(entry));

    return Array.from(new Set(normalized));
  }

  function getHiddenColumnsForRoster(settings: SettingsPayload | null | undefined, rosterId: string) {
    const safeSettings: Partial<SettingsPayload> = settings ?? {};
    const byRoster = (safeSettings.hiddenColumnsByRoster || {}) as Record<string, string[]>;

    if (rosterId && Array.isArray(byRoster[rosterId])) {
      return sanitizeHiddenColumns(byRoster[rosterId]);
    }

    if (Array.isArray(safeSettings.hiddenColumns)) {
      return sanitizeHiddenColumns(safeSettings.hiddenColumns);
    }

    if (Array.isArray(safeSettings.hiddenBossColumns)) {
      return sanitizeHiddenColumns(safeSettings.hiddenBossColumns);
    }

    return [];
  }

  function getVisibleRosterIdsForActive(
    safeSettings: SettingsPayload | null | undefined,
    activeId: string,
    rosterIds: string[]
  ) {
    const settingsNow: Partial<SettingsPayload> = safeSettings ?? {};
    const byRoster = (settingsNow.visibleWeeklyRostersByRoster || {}) as Record<string, string[]>;
    const hasEntry = Boolean(activeId) && Object.prototype.hasOwnProperty.call(byRoster, activeId);

    const selected = hasEntry
      ? (Array.isArray(byRoster[activeId]) ? byRoster[activeId] : [])
      : [];

    const selectedList = (selected || [])
      .map((id: unknown) => String(id))
      .filter((id: string) => rosterIds.includes(id));

    if (activeId && !selectedList.includes(activeId)) {
      selectedList.push(activeId);
    }

    return rosterIds.filter((id) => selectedList.includes(id));
  }

  function buildWeeklyCardsFromState(
    activeRosterIdState: string,
    visibleRosterIdsState: string[],
    rosterNamesByIdState: Record<string, string>,
    rosterCardsCacheState: Record<string, WeeklyCardSnapshot>,
    rosterState: Record<string, RosterCharacter | unknown>,
    orderState: string[],
    characterDataState: CharacterDataMap,
    dailyDataState: DailyData | null,
    hiddenColumnsState: string[]
  ) {
    const cards: WeeklyCardSnapshot[] = [];

    const normalizedActiveRosterId = String(activeRosterIdState || '').trim();
    let normalizedVisibleRosterIds = Array.from(
      new Set((visibleRosterIdsState || []).map((id) => String(id || '').trim()).filter((id) => Boolean(id)))
    );

    if (normalizedActiveRosterId) {
      normalizedVisibleRosterIds = [
        normalizedActiveRosterId,
        ...normalizedVisibleRosterIds.filter((id) => id !== normalizedActiveRosterId),
      ];
    }

    normalizedVisibleRosterIds.forEach((rosterId) => {
      if (rosterId === normalizedActiveRosterId) {
        cards.push({
          rosterId,
          rosterName: rosterNamesByIdState[rosterId] || 'Weekly Tracker',
          roster: rosterState,
          order: orderState,
          characterData: characterDataState,
          dailyData: dailyDataState,
          hiddenColumns: hiddenColumnsState,
          isActive: true,
        });
        return;
      }

      const cached = rosterCardsCacheState[rosterId];
      if (!cached) return;

      cards.push({
        ...cached,
        rosterName: rosterNamesByIdState[rosterId] || cached.rosterName || 'Weekly Tracker',
        isActive: false,
      });
    });

    const hasActiveCard = cards.some((card) => card.isActive);
    if (!hasActiveCard && normalizedActiveRosterId) {
      cards.unshift({
        rosterId: normalizedActiveRosterId,
        rosterName: rosterNamesByIdState[normalizedActiveRosterId] || 'Weekly Tracker',
        roster: rosterState,
        order: orderState,
        characterData: characterDataState,
        dailyData: dailyDataState,
        hiddenColumns: hiddenColumnsState,
        isActive: true,
      });
    }

    return cards;
  }

  async function ensureActiveRosterId() {
    const current = await api.getActiveRoster?.();
    const currentId = String(current || '').trim();
    debugWeekly('ensureActiveRosterId:read-active', { currentId });

    if (currentId) {
      activeRosterId = currentId;
      debugWeekly('ensureActiveRosterId:using-active', { activeRosterId });
      return activeRosterId;
    }

    const rosterList = await api.getRosterList?.();
    debugWeekly('ensureActiveRosterId:roster-list', {
      rosterCount: Array.isArray(rosterList) ? rosterList.length : 0,
      rosterIds: Array.isArray(rosterList) ? rosterList.map((entry) => String(entry?.id || '')) : [],
    });
    if (Array.isArray(rosterList) && rosterList.length > 0) {
      const fallbackId = String(rosterList[0]?.id || '').trim();
      if (fallbackId) {
        await api.switchActiveRoster?.(fallbackId);
        activeRosterId = fallbackId;
        debugWeekly('ensureActiveRosterId:switched-fallback', { activeRosterId });
        return activeRosterId;
      }
    }

    const created = await api.createRoster?.('Main Roster');
    if (created) {
      await api.switchActiveRoster?.(created);
      activeRosterId = created;
      debugWeekly('ensureActiveRosterId:created-main', { activeRosterId });
      return activeRosterId;
    }

    debugWeekly('ensureActiveRosterId:failed-empty');
    return '';
  }

  function handleRosterChanged() {
    debugWeekly('handleRosterChanged:reload');
    loadAll();
  }

  function getCharacter(name: string) {
    const value = roster[name] as RosterCharacter | undefined;
    if (!value || typeof value !== 'object') return null;

    const source = value as Record<string, unknown>;
    const candidate = source.data && typeof source.data === 'object'
      ? (source.data as Record<string, unknown>)
      : source;

    const rawVisible = candidate.visible ?? source.visible;
    const rawCombatPower = candidate.combatPower ?? candidate.cp ?? source.combatPower;

    return {
      class: String(candidate.class ?? candidate.charClass ?? candidate.characterClass ?? ''),
      ilvl: Number(candidate.ilvl ?? candidate.itemLevel ?? candidate.iLvl ?? 0),
      visible: rawVisible !== false,
      combatPower: Number.isFinite(Number(rawCombatPower)) && Number(rawCombatPower) > 0 ? Number(rawCombatPower) : null,
    };
  }

  function getCharacterFromRoster(rosterState: Record<string, RosterCharacter | unknown>, name: string) {
    const value = rosterState[name] as RosterCharacter | undefined;
    if (!value || typeof value !== 'object') return null;

    const source = value as Record<string, unknown>;
    const candidate = source.data && typeof source.data === 'object'
      ? (source.data as Record<string, unknown>)
      : source;

    const rawVisible = candidate.visible ?? source.visible;
    const rawCombatPower = candidate.combatPower ?? candidate.cp ?? source.combatPower;

    return {
      class: String(candidate.class ?? candidate.charClass ?? candidate.characterClass ?? ''),
      ilvl: Number(candidate.ilvl ?? candidate.itemLevel ?? candidate.iLvl ?? 0),
      visible: rawVisible !== false,
      combatPower: Number.isFinite(Number(rawCombatPower)) && Number(rawCombatPower) > 0 ? Number(rawCombatPower) : null,
    };
  }

  function getClassIconPath(className: string) {
    const icon = (CLASS_ICONS as Record<string, string>)[className];
    return icon ? `./assets/icons/${icon}` : null;
  }

  function getCharacterNames() {
    return Object.keys(roster).filter((name) => name !== 'dailyData');
  }

  function getVisibleCharacters(
    rosterState: Record<string, RosterCharacter | unknown>,
    orderState: string[]
  ) {
    const names = Object.keys(rosterState).filter((name) => name !== 'dailyData');
    const normalizedOrder = orderState.filter((name) => names.includes(name));
    const missing = names.filter((name) => !normalizedOrder.includes(name));
    const all = [...normalizedOrder, ...missing];

    const visible = all.filter((name) => getCharacter(name)?.visible !== false);

    if (visible.length === 0 && all.length > 0) {
      debugWeekly('getVisibleCharacters:all-filtered-out', {
        all,
        sampleEntries: all.map((name) => {
          const raw = roster[name] as unknown;
          return {
            name,
            rawType: typeof raw,
            hasRaw: raw !== undefined && raw !== null,
            parsed: getCharacter(name),
          };
        }),
      });
    }

    if (visible.length === 0 && all.length > 0) {
      debugWeekly('getVisibleCharacters:fallback-all', {
        names: all,
        visibilityByName: all.map((name) => ({
          name,
          visible: getCharacter(name)?.visible,
        })),
      });
      return all;
    }

    return visible;
  }

  function getVisibleCharactersForRoster(
    rosterState: Record<string, RosterCharacter | unknown>,
    orderState: string[]
  ) {
    const names = Object.keys(rosterState || {}).filter((name) => name !== 'dailyData');
    const normalizedOrder = (orderState || []).filter((name) => names.includes(name));
    const missing = names.filter((name) => !normalizedOrder.includes(name));
    const all = [...normalizedOrder, ...missing];
    const visible = all.filter((name) => getCharacterFromRoster(rosterState, name)?.visible !== false);
    return visible.length === 0 ? all : visible;
  }

  function normalizeDifficulty(value: unknown): Difficulty {
    const safe = String(value || '').trim();
    if (safe === 'Normal' || safe === 'Hard' || safe === 'Nightmare') return safe;
    return 'Solo';
  }

  function normalizeRaidBossId(boss: string) {
    return normalizeRaidKey(boss, RAID_CONFIG as Array<any>, { allowUnknown: false });
  }

  function getBossLookupKeys(boss: string) {
    const normalizedId = normalizeRaidBossId(boss);
    const keys: string[] = [];

    const raw = String(boss || '').trim();
    if (raw && !keys.includes(raw)) keys.push(raw);
    if (normalizedId && !keys.includes(normalizedId)) keys.push(normalizedId);

    const legacySimple = BOSSES.find((item) => normalizeRaidBossId(item) === normalizedId);
    if (legacySimple) {
      const legacy = String(legacySimple);
      if (!keys.includes(legacy)) keys.push(legacy);
    }

    return keys;
  }

  function getRaidCell(characterDataState: CharacterDataMap, characterName: string, boss: string): RaidCell {
    const lookupKeys = getBossLookupKeys(boss);
    let cell: unknown = undefined;

    for (const key of lookupKeys) {
      const candidate = characterDataState?.[characterName]?.[key];
      if (candidate && typeof candidate === 'object') {
        cell = candidate;
        break;
      }
    }

    if (!cell || typeof cell !== 'object') {
      return { ...DEFAULT_RAID_CELL };
    }

    const rawOpenCount = Number((cell as { chestOpenCount?: unknown }).chestOpenCount);
    const fallbackOpenCount = (cell as RaidCell).chestOpened ? 1 : 0;
    const maxChestOpenCount = getMaxChestOpenCountForBoss(boss);
    const parsedOpenCount = Number.isFinite(rawOpenCount) ? Math.floor(rawOpenCount) : fallbackOpenCount;
    const chestOpenCount = Math.max(0, Math.min(maxChestOpenCount, parsedOpenCount));

    return {
      cleared: Boolean((cell as RaidCell).cleared),
      difficulty: normalizeDifficulty((cell as RaidCell).difficulty),
      hidden: Boolean((cell as RaidCell).hidden),
      chestOpened: chestOpenCount > 0,
      chestOpenCount,
      timestamp: (cell as RaidCell).timestamp || null,
    };
  }

  function getRaidConfigByBoss(boss: string) {
    const normalizedId = normalizeRaidBossId(boss);
    if (!normalizedId) return undefined;
    return RAID_CONFIG.find((entry: any) => String(entry.id || '') === normalizedId);
  }

  function getRaidLabel(boss: string) {
    const raid = getRaidConfigByBoss(boss) as { label?: string } | undefined;
    return String(raid?.label || boss);
  }

  function getMaxChestOpenCountForBoss(boss: string) {
    const raid = getRaidConfigByBoss(boss) as { id?: string } | undefined;
    const raidId = String(raid?.id || normalizeRaidBossId(boss) || '').toLowerCase();
    return DOUBLE_CHEST_RAID_IDS.has(raidId) ? 2 : 1;
  }

  function isEligibleForRoster(
    rosterState: Record<string, RosterCharacter | unknown>,
    characterName: string,
    boss: string
  ) {
    const character = getCharacterFromRoster(rosterState, characterName);
    const raid = getRaidConfigByBoss(boss);
    if (!character || !raid) return false;
    return character.ilvl >= Number(raid.nm || 0);
  }

  function disallowSoloForBoss(boss: string) {
    const raid = getRaidConfigByBoss(boss) as { id?: string } | undefined;
    const raidId = String(raid?.id || normalizeRaidBossId(boss) || '').toLowerCase();
    return raidId === 'armoche' || raidId === 'kazeros' || raidId === 'serka';
  }

  async function persistCharacterData() {
    if (!activeRosterId) return;
    await api.saveCharacterData?.(activeRosterId, characterData);
  }

  async function persistRoster() {
    if (!activeRosterId) return;
    await api.saveRoster?.(activeRosterId, { roster, order });
  }

  function getCurrentDailyStartIso() {
    return getCurrentDailyPeriod().startIso;
  }

  function getCurrentDailyPeriod(nowMs = Date.now()): DailyPeriod {
    const nowDate = new Date(nowMs);
    const baseStartMs = Date.UTC(
      nowDate.getUTCFullYear(),
      nowDate.getUTCMonth(),
      nowDate.getUTCDate(),
      DAILY_RESET.HOUR_UTC,
      0,
      0,
      0,
    );

    const needsPreviousDay = nowDate.getUTCHours() < DAILY_RESET.HOUR_UTC;
    const startMs = needsPreviousDay ? baseStartMs - (24 * 60 * 60 * 1000) : baseStartMs;
    const endMs = startMs + (24 * 60 * 60 * 1000);

    return {
      startMs,
      endMs,
      startIso: new Date(startMs).toISOString(),
    };
  }

  function isDailyDataExpired(savedDate: unknown, period: DailyPeriod) {
    if (!savedDate) return true;
    const parsedMs = Date.parse(String(savedDate));
    if (!Number.isFinite(parsedMs)) return true;
    return parsedMs < period.startMs || parsedMs >= period.endMs;
  }

  function getRosterCharacterNames(rosterState: Record<string, unknown>, orderState: string[]) {
    const names = Object.keys(rosterState || {}).filter((name) => name !== 'dailyData');
    const normalizedOrder = (orderState || [])
      .map((name) => String(name || '').trim())
      .filter((name) => Boolean(name) && names.includes(name));
    const missing = names.filter((name) => !normalizedOrder.includes(name));
    return [...normalizedOrder, ...missing];
  }

  function buildResetDailyData(characterNames: string[], period: DailyPeriod): DailyData {
    return {
      date: period.startIso,
      characters: Object.fromEntries(
        characterNames.map((name) => [
          name,
          {
            guardianRaid: defaultActivity(),
            chaosDungeon: defaultActivity(),
          },
        ])
      ),
      roster: {
        fieldBoss: defaultActivity(),
        chaosGate: defaultActivity(),
        thaemine: defaultActivity(),
      },
    };
  }

  async function resetExpiredDailiesForAllRosters(period: DailyPeriod) {
    const rosterList = await api.getRosterList?.();
    if (!Array.isArray(rosterList) || rosterList.length === 0) {
      return;
    }

    const weeklyPeriod = await api.getWeeklyResetPeriod?.();
    const weeklyStartIso = new Date(weeklyPeriod?.start || 0).toISOString();

    for (const rosterMeta of rosterList) {
      const rosterId = String(rosterMeta?.id || '').trim();
      if (!rosterId) continue;

      const loaded = await api.loadRoster?.(rosterId);
      const rosterData = (loaded?.roster || {}) as Record<string, unknown>;
      const orderData = Array.isArray(loaded?.order) ? loaded.order : [];

      const currentDailyData = rosterData?.dailyData as DailyData | undefined;
      const savedDailyDate = currentDailyData?.date;
      
      if (!isDailyDataExpired(savedDailyDate, period)) {
        continue;
      }

      const characterNames = getRosterCharacterNames(rosterData, orderData);
      const resetDailyData = buildResetDailyData(characterNames, period);

      // Preserve Thaemine if weekly reset hasn't happened yet
      if (currentDailyData?.roster?.thaemine?.timestamp) {
        const thaemineTime = new Date(currentDailyData.roster.thaemine.timestamp).getTime();
        if (thaemineTime >= (weeklyPeriod?.start || 0) && thaemineTime < (weeklyPeriod?.end || 0)) {
          resetDailyData.roster.thaemine = currentDailyData.roster.thaemine;
        }
      }

      await api.saveRoster?.(rosterId, {
        roster: {
          ...rosterData,
          dailyData: resetDailyData,
        },
        order: orderData,
      });
    }
  }

  async function ensureDailyResetParity() {
    const period = getCurrentDailyPeriod();
    if (dailyResetCheckedForPeriod === period.startIso) {
      return;
    }

    await resetExpiredDailiesForAllRosters(period);
    dailyResetCheckedForPeriod = period.startIso;
  }

  function defaultActivity(overrides?: Partial<DailyActivity>): DailyActivity {
    return {
      completed: false,
      boss: null,
      timestamp: null,
      ...(overrides || {}),
    };
  }

  function normalizeApiActivity(result: unknown, fallbackBoss: string | null = null): DailyActivity {
    if (typeof result === 'boolean') {
      return defaultActivity({
        completed: result,
        boss: result ? fallbackBoss : null,
        timestamp: result ? new Date().toISOString() : null,
      });
    }

    if (!result || typeof result !== 'object') {
      return defaultActivity();
    }

    const source = result as Record<string, unknown>;
    const completed = Boolean(source.completed);
    const rawTimestamp = source.timestamp;
    const timestamp = rawTimestamp ? new Date(rawTimestamp as string | number).toISOString() : (completed ? new Date().toISOString() : null);
    const boss = String(source.boss || '').trim() || (completed ? fallbackBoss : null);

    return defaultActivity({
      completed,
      boss,
      timestamp,
    });
  }

  function formatTimestamp(timestamp: string | null) {
    if (!timestamp) return '';
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return '';

    const timezone = settings?.timezone && settings.timezone !== 'browser' && settings.timezone !== 'local'
      ? settings.timezone
      : undefined;
    const locale = navigator?.language || 'en-US';
    const hour12 = settings?.timeFormat === '12h'
      ? true
      : settings?.timeFormat === '24h'
        ? false
        : undefined;

    return new Intl.DateTimeFormat(locale, {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12,
    }).format(date);
  }

  function buildDailyTooltip(activity: DailyActivity | null | undefined) {
    if (!activity?.timestamp) return '';
    const dateText = formatTimestamp(activity.timestamp);
    const bossText = activity.boss ? ` - ${activity.boss}` : '';
    return `${dateText}${bossText}`;
  }

  function preserveHiddenStates(source: CharacterDataMap) {
    const hiddenStates: Record<string, Record<string, true>> = {};

    Object.keys(source || {}).forEach((characterName) => {
      const entry = source[characterName];
      if (!entry || typeof entry !== 'object') return;
      Object.keys(entry).forEach((boss) => {
        if (boss === '_extraGold') return;
        const cell = (entry as Record<string, unknown>)[boss] as RaidCell | undefined;
        if (cell?.hidden) {
          if (!hiddenStates[characterName]) {
            hiddenStates[characterName] = {};
          }
          hiddenStates[characterName][boss] = true;
        }
      });
    });

    return hiddenStates;
  }

  function restoreHiddenStates(target: CharacterDataMap, hiddenStates: Record<string, Record<string, true>>) {
    Object.keys(hiddenStates || {}).forEach((characterName) => {
      if (!target[characterName]) {
        target[characterName] = {} as CharacterBossData;
      }

      Object.keys(hiddenStates[characterName] || {}).forEach((boss) => {
        const current = getRaidCell(target, characterName, boss);
        target[characterName][boss] = {
          ...current,
          hidden: true,
        };
      });
    });
  }

  function buildDefaultDailyDataForRoster() {
    return {
      date: getCurrentDailyStartIso(),
      characters: Object.fromEntries(
        getCharacterNames().map((name) => [
          name,
          {
            guardianRaid: defaultActivity(),
            chaosDungeon: defaultActivity(),
          },
        ])
      ),
      roster: {
        fieldBoss: defaultActivity(),
        chaosGate: defaultActivity(),
        thaemine: defaultActivity(),
      },
    } satisfies DailyData;
  }

  function buildDefaultDailyDataForRosterFrom(
    rosterState: Record<string, unknown>,
    orderState: string[]
  ) {
    const names = getRosterCharacterNames(rosterState, orderState);
    return {
      date: getCurrentDailyStartIso(),
      characters: Object.fromEntries(
        names.map((name) => [
          name,
          {
            guardianRaid: defaultActivity(),
            chaosDungeon: defaultActivity(),
          },
        ])
      ),
      roster: {
        fieldBoss: defaultActivity(),
        chaosGate: defaultActivity(),
        thaemine: defaultActivity(),
      },
    } satisfies DailyData;
  }

  function getAllowedDifficultiesForRoster(
    rosterState: Record<string, RosterCharacter | unknown>,
    characterName: string,
    boss: string
  ): Difficulty[] {
    const character = getCharacterFromRoster(rosterState, characterName);
    const raid = getRaidConfigByBoss(boss);
    const soloDisabled = disallowSoloForBoss(boss);

    if (!character || !raid) {
      return soloDisabled ? ['Normal'] : ['Solo', 'Normal'];
    }

    if (character.ilvl >= Number((raid as any).nmr || 9999)) {
      return soloDisabled ? ['Normal', 'Hard', 'Nightmare'] : ['Solo', 'Normal', 'Hard', 'Nightmare'];
    }

    if (character.ilvl >= Number((raid as any).hm || 9999)) {
      return soloDisabled ? ['Normal', 'Hard'] : ['Solo', 'Normal', 'Hard'];
    }

    return soloDisabled ? ['Normal'] : ['Solo', 'Normal'];
  }

  function highlightSettingsButtonCta() {
    document.dispatchEvent(new CustomEvent('wtl-highlight-settings-cta'));
  }

  async function ensureDatabaseReady(silent = false) {
    let hasDb = await api.checkDatabaseExists?.();
    if (hasDb) {
      return true;
    }

    const hasConfiguredDbPath = Boolean(String(settings?.dbPath || '').trim());
    const canRequestPersistentAccess = Boolean(dbAccessSupport?.persistentHandle);
    if (!silent && hasConfiguredDbPath && canRequestPersistentAccess && api.requestDatabasePermission) {
      const permResult = await api.requestDatabasePermission();

      if (permResult?.ok) {
        hasDb = await api.checkDatabaseExists?.();
        if (hasDb) return true;
      } else if (permResult?.reason === 'permission-denied') {
        showToast('Browser permission denied. Grant access and try again.', TOAST_TYPES.ERROR);
        return false;
      } else if (permResult?.reason === 'unsupported-browser') {
        showToast('This browser supports database load only for the current session. Re-import encounters.db in Settings. For the best experience, please use Chrome, Edge, or Opera.', TOAST_TYPES.INFO);
        return false;
      }
    } else if (!silent && hasConfiguredDbPath && !canRequestPersistentAccess) {
      showToast('This browser supports database load only for the current session. Re-import encounters.db in Settings. For the best experience, please use Chrome, Edge, or Opera.', TOAST_TYPES.INFO);
      return false;
    }

    if (!silent) {
      showToast('No database loaded. Set encounters.db in Settings first.', TOAST_TYPES.ERROR);
      highlightSettingsButtonCta();
    }

    return false;
  }

  function normalizeDailyData() {
    const raw = (roster.dailyData as DailyData | undefined) || null;
    const date = raw?.date || getCurrentDailyStartIso();

    const characters = Object.fromEntries(
      getCharacterNames().map((name) => {
        const entry = raw?.characters?.[name];
        return [
          name,
          {
            guardianRaid: defaultActivity(entry?.guardianRaid),
            chaosDungeon: defaultActivity(entry?.chaosDungeon),
          },
        ];
      })
    );

    const rosterDaily = {
      fieldBoss: defaultActivity(raw?.roster?.fieldBoss),
      chaosGate: defaultActivity(raw?.roster?.chaosGate),
      thaemine: defaultActivity(raw?.roster?.thaemine),
    };

    dailyData = {
      date,
      characters,
      roster: rosterDaily,
    };

    roster = {
      ...roster,
      dailyData,
    };
  }

  async function loadAll() {
    loading = true;
    updateDebugSnapshot('loadAll:start');
    debugWeekly('loadAll:start');
    try {
      await ensureDailyResetParity();

      const rosterId = await ensureActiveRosterId();
      if (!rosterId) {
        updateDebugSnapshot('loadAll:no-active-roster');
        showToast('No active roster selected', TOAST_TYPES.ERROR);
        debugWeekly('loadAll:no-active-roster');
        return;
      }

      activeRosterId = rosterId;
      const [loadedRoster, loadedCharacterData, loadedSettings, loadedRosterMeta] = await Promise.all([
        api.loadRoster?.(rosterId),
        api.loadCharacterData?.(rosterId),
        api.loadSettings?.(),
        api.getRosterList?.(),
      ]);
      await refreshDbAccessSupport();
      debugWeekly('loadAll:payload-loaded', {
        rosterId,
        loadedRosterKeys: Object.keys((loadedRoster?.roster || {}) as Record<string, unknown>),
        loadedOrder: Array.isArray(loadedRoster?.order) ? loadedRoster.order : [],
        characterDataKeys: Object.keys((loadedCharacterData || {}) as Record<string, unknown>),
      });

      roster = (loadedRoster?.roster || {}) as Record<string, RosterCharacter | unknown>;

      const rosterNames = Object.keys(roster).filter((name) => name !== 'dailyData');
      const loadedOrder = Array.isArray(loadedRoster?.order)
        ? loadedRoster.order.map((name: unknown) => String(name || '').trim()).filter((name: string) => Boolean(name) && rosterNames.includes(name))
        : [];
      const missingNames = rosterNames.filter((name) => !loadedOrder.includes(name));
      order = [...loadedOrder, ...missingNames];
      debugWeekly('loadAll:order-normalized', {
        rosterId,
        rosterNames,
        loadedOrder,
        missingNames,
        finalOrder: order,
      });

      characterData = (loadedCharacterData || {}) as CharacterDataMap;
      settings = (loadedSettings || {}) as SettingsPayload;
      hiddenColumns = getHiddenColumnsForRoster(settings, rosterId);
      const rosterMeta = Array.isArray(loadedRosterMeta) ? loadedRosterMeta : [];
      const allRosterIdsFromMeta = rosterMeta
        .map((item) => String(item?.id || '').trim())
        .filter((id) => Boolean(id));
      const allRosterIds = Array.from(new Set([
        ...allRosterIdsFromMeta,
        rosterId,
      ]));
      rosterNamesById = Object.fromEntries(
        rosterMeta
          .map((item) => [String(item?.id || '').trim(), String(item?.name || '').trim() || 'Weekly Tracker'])
          .filter(([id]) => Boolean(id))
      );
      rosterNamesById = {
        [rosterId]: rosterNamesById[rosterId] || 'Weekly Tracker',
        ...rosterNamesById,
      };
      visibleRosterIds = getVisibleRosterIdsForActive(settings, rosterId, allRosterIds);
      if (visibleRosterIds.length === 0) {
        visibleRosterIds = [rosterId];
      }

      const nextCache: Record<string, WeeklyCardSnapshot> = {};
      await Promise.all(
        visibleRosterIds
          .filter((id) => id !== rosterId)
          .map(async (id) => {
            const [rosterPayload, characterPayload] = await Promise.all([
              api.loadRoster?.(id),
              api.loadCharacterData?.(id),
            ]);

            const rosterState = (rosterPayload?.roster || {}) as Record<string, RosterCharacter | unknown>;
            const rosterNamesLocal = Object.keys(rosterState).filter((name) => name !== 'dailyData');
            const rawOrder = Array.isArray(rosterPayload?.order)
              ? rosterPayload.order.map((name: unknown) => String(name || '').trim()).filter((name: string) => Boolean(name) && rosterNamesLocal.includes(name))
              : [];
            const missing = rosterNamesLocal.filter((name) => !rawOrder.includes(name));
            const finalOrder = [...rawOrder, ...missing];

            nextCache[id] = {
              rosterId: id,
              rosterName: rosterNamesById[id] || 'Weekly Tracker',
              roster: rosterState,
              order: finalOrder,
              characterData: (characterPayload || {}) as CharacterDataMap,
              dailyData: ((rosterState.dailyData as DailyData | undefined) || null),
              hiddenColumns: getHiddenColumnsForRoster(settings, id),
              isActive: false,
            };
          })
      );
      rosterCardsCache = nextCache;
      normalizeDailyData();

      const nextCards = buildWeeklyCardsFromState(
        activeRosterId,
        visibleRosterIds,
        rosterNamesById,
        rosterCardsCache,
        roster,
        order,
        characterData,
        dailyData,
        hiddenColumns
      );
      weeklyCards = nextCards;
      lastComputedCardsCount = nextCards.length;
      if (nextCards.length === 0) {
        await reportError(new Error('Weekly cards list is empty after loadAll'), {
          code: ERROR_CODES.WEEKLY.EMPTY_CARDS,
          severity: 'warning',
          context: {
            activeRosterId: rosterId,
            allRosterIds,
            visibleRosterIds,
            rosterNamesCount: Object.keys(rosterNamesById || {}).length,
            rosterKeys: Object.keys(roster || {}).filter((name) => name !== 'dailyData'),
          },
          showToast: true,
        });
      }

      updateDebugSnapshot('loadAll:success', {
        allRosterIds,
        rosterNamesCount: Object.keys(rosterNamesById || {}).length,
        computedCardsCount: nextCards.length,
        activeRosterCardExpected: String(activeRosterId || '').trim(),
      });

      debugWeeklyState('loadAll:completed');
    } catch (error: any) {
      const reported = await reportError(error, {
        code: ERROR_CODES.WEEKLY.LOAD_ALL_FAILED,
        severity: 'error',
        context: {
          action: 'load-all',
          rosterId: activeRosterId,
          activeRosterId,
          visibleRosterIds,
          rosterKeys: Object.keys(roster || {}).filter((name) => name !== 'dailyData'),
          orderCount: Array.isArray(order) ? order.length : 0,
        },
        showToast: false,
      });
      updateDebugSnapshot('loadAll:error', {
        error: error?.message || String(error),
      });
      showToast(reported.message, TOAST_TYPES.ERROR);
      debugWeekly('loadAll:error', {
        message: error?.message || 'unknown error',
      });
    } finally {
      loading = false;
      updateDebugSnapshot('loadAll:finish');
      debugWeekly('loadAll:finish', { loading });
    }
  }

  async function getRosterStateForTarget(rosterId: string) {
    const targetRosterId = String(rosterId || '').trim();
    const isActiveTarget = targetRosterId === activeRosterId;

    if (isActiveTarget) {
      return {
        isActiveTarget,
        rosterState: roster,
        orderState: order,
      };
    }

    const cached = rosterCardsCache[targetRosterId];
    if (cached) {
      return {
        isActiveTarget,
        rosterState: cached.roster,
        orderState: cached.order,
      };
    }

    const loaded = (await api.loadRoster?.(targetRosterId)) as RosterPayload | null;
    const rosterState = (loaded?.roster || {}) as Record<string, RosterCharacter | unknown>;
    const orderState = Array.isArray(loaded?.order)
      ? loaded.order.map((name: unknown) => String(name || '').trim()).filter((name: string) => Boolean(name))
      : Object.keys(rosterState).filter((name) => name !== 'dailyData');

    return {
      isActiveTarget,
      rosterState,
      orderState,
    };
  }

  async function getCharacterDataForTarget(rosterId: string) {
    const targetRosterId = String(rosterId || '').trim();
    if (targetRosterId === activeRosterId) {
      return { ...(characterData || {}) } as CharacterDataMap;
    }

    const cached = rosterCardsCache[targetRosterId];
    if (cached) {
      return { ...(cached.characterData || {}) } as CharacterDataMap;
    }

    const loaded = (await api.loadCharacterData?.(targetRosterId)) as CharacterDataMap | null;
    return { ...(loaded || {}) } as CharacterDataMap;
  }

  async function persistCharacterDataForTarget(rosterId: string, nextCharacterData: CharacterDataMap) {
    const targetRosterId = String(rosterId || '').trim();
    if (!targetRosterId) return;

    await api.saveCharacterData?.(targetRosterId, nextCharacterData);

    if (targetRosterId === activeRosterId) {
      characterData = nextCharacterData;
    }

    const cached = rosterCardsCache[targetRosterId];
    if (cached) {
      rosterCardsCache[targetRosterId] = {
        ...cached,
        characterData: nextCharacterData,
      };
      rosterCardsCache = { ...rosterCardsCache };
    }
  }

  async function getDailyStateForTarget(rosterId: string) {
    const targetRosterId = String(rosterId || '').trim();
    const { isActiveTarget, rosterState, orderState } = await getRosterStateForTarget(targetRosterId);

    const sourceDaily = isActiveTarget
      ? dailyData
      : ((rosterState.dailyData as DailyData | undefined) || rosterCardsCache[targetRosterId]?.dailyData || null);

    const dailyState: DailyData = sourceDaily || buildDefaultDailyDataForRosterFrom(
      rosterState as Record<string, unknown>,
      orderState
    );

    return {
      isActiveTarget,
      rosterState,
      orderState,
      dailyState,
    };
  }

  async function persistDailyStateForTarget(
    rosterId: string,
    rosterState: Record<string, RosterCharacter | unknown>,
    orderState: string[],
    dailyState: DailyData
  ) {
    const targetRosterId = String(rosterId || '').trim();
    if (!targetRosterId) return;

    const nextRosterState = {
      ...rosterState,
      dailyData: dailyState,
    };

    await api.saveRoster?.(targetRosterId, {
      roster: nextRosterState,
      order: orderState,
    });

    if (targetRosterId === activeRosterId) {
      roster = nextRosterState;
      dailyData = dailyState;
    }

    const cached = rosterCardsCache[targetRosterId];
    if (cached) {
      rosterCardsCache[targetRosterId] = {
        ...cached,
        roster: nextRosterState,
        order: orderState,
        dailyData: dailyState,
      };
      rosterCardsCache = { ...rosterCardsCache };
    }
  }

  async function toggleRaid(rosterId: string, characterName: string, boss: string, checked: boolean) {
    const targetRosterId = String(rosterId || '').trim();
    if (loading || !targetRosterId) {
      showToast('Weekly action blocked: page is loading or no active roster.', TOAST_TYPES.WARNING);
      return;
    }

    const { rosterState } = await getRosterStateForTarget(targetRosterId);
    if (!isEligibleForRoster(rosterState, characterName, boss)) {
      showToast(`Character not eligible for ${getRaidLabel(boss)}.`, TOAST_TYPES.WARNING);
      return;
    }

    const nextCharacterData = await getCharacterDataForTarget(targetRosterId);
    if (!nextCharacterData[characterName]) {
      nextCharacterData[characterName] = {} as CharacterBossData;
    }

    const current = getRaidCell(nextCharacterData, characterName, boss);
    const allowedDifficulties = getAllowedDifficultiesForRoster(rosterState, characterName, boss);
    const nextDifficulty = checked
      ? (allowedDifficulties.includes(current.difficulty) ? current.difficulty : allowedDifficulties[0])
      : current.difficulty;

    nextCharacterData[characterName][boss] = {
      ...current,
      cleared: checked,
      difficulty: nextDifficulty,
      timestamp: checked ? new Date().toISOString() : null,
    };

    nextCharacterData[characterName] = { ...nextCharacterData[characterName] };
    await persistCharacterDataForTarget(targetRosterId, nextCharacterData);
  }

  async function cycleDifficulty(rosterId: string, characterName: string, boss: string) {
    const targetRosterId = String(rosterId || '').trim();
    if (loading || !targetRosterId) {
      showToast('Difficulty change blocked: page is loading or no active roster.', TOAST_TYPES.WARNING);
      return;
    }

    const { rosterState } = await getRosterStateForTarget(targetRosterId);
    if (!isEligibleForRoster(rosterState, characterName, boss)) {
      showToast(`Character not eligible for ${getRaidLabel(boss)}.`, TOAST_TYPES.WARNING);
      return;
    }

    const nextCharacterData = await getCharacterDataForTarget(targetRosterId);
    if (!nextCharacterData[characterName]) {
      nextCharacterData[characterName] = {} as CharacterBossData;
    }

    const current = getRaidCell(nextCharacterData, characterName, boss);
    if (!current.cleared) return;

    const allowedDifficulties = getAllowedDifficultiesForRoster(rosterState, characterName, boss);
    const currentIndex = allowedDifficulties.indexOf(current.difficulty);
    const nextDifficulty = currentIndex < 0
      ? allowedDifficulties[0]
      : allowedDifficulties[(currentIndex + 1) % allowedDifficulties.length];

    nextCharacterData[characterName][boss] = {
      ...current,
      difficulty: nextDifficulty,
    };

    nextCharacterData[characterName] = { ...nextCharacterData[characterName] };
    await persistCharacterDataForTarget(targetRosterId, nextCharacterData);
  }

  async function toggleChest(rosterId: string, characterName: string, boss: string) {
    const targetRosterId = String(rosterId || '').trim();
    if (loading || !targetRosterId) {
      showToast('Chest toggle blocked: page is loading or no active roster.', TOAST_TYPES.WARNING);
      return;
    }

    const { rosterState } = await getRosterStateForTarget(targetRosterId);
    if (!isEligibleForRoster(rosterState, characterName, boss)) {
      showToast(`Character not eligible for ${getRaidLabel(boss)}.`, TOAST_TYPES.WARNING);
      return;
    }

    const nextCharacterData = await getCharacterDataForTarget(targetRosterId);
    if (!nextCharacterData[characterName]) {
      nextCharacterData[characterName] = {} as CharacterBossData;
    }

    const current = getRaidCell(nextCharacterData, characterName, boss);
    const maxChestOpenCount = getMaxChestOpenCountForBoss(boss);
    const nextChestOpenCount = (current.chestOpenCount + 1) % (maxChestOpenCount + 1);
    nextCharacterData[characterName][boss] = {
      ...current,
      chestOpened: nextChestOpenCount > 0,
      chestOpenCount: nextChestOpenCount,
    };

    nextCharacterData[characterName] = { ...nextCharacterData[characterName] };
    await persistCharacterDataForTarget(targetRosterId, nextCharacterData);
  }

  async function toggleHidden(rosterId: string, characterName: string, boss: string) {
    const targetRosterId = String(rosterId || '').trim();
    if (loading || !targetRosterId) {
      showToast('Hide toggle blocked: page is loading or no active roster.', TOAST_TYPES.WARNING);
      return;
    }

    const { rosterState } = await getRosterStateForTarget(targetRosterId);
    if (!isEligibleForRoster(rosterState, characterName, boss)) {
      showToast(`Character not eligible for ${getRaidLabel(boss)}.`, TOAST_TYPES.WARNING);
      return;
    }

    const nextCharacterData = await getCharacterDataForTarget(targetRosterId);
    if (!nextCharacterData[characterName]) {
      nextCharacterData[characterName] = {} as CharacterBossData;
    }

    const current = getRaidCell(nextCharacterData, characterName, boss);
    nextCharacterData[characterName][boss] = {
      ...current,
      hidden: !current.hidden,
    };

    nextCharacterData[characterName] = { ...nextCharacterData[characterName] };
    await persistCharacterDataForTarget(targetRosterId, nextCharacterData);
  }

  async function openGoldBonus(rosterId: string, characterName: string) {
    const targetRosterId = String(rosterId || '').trim();
    if (!targetRosterId) return;

    const targetCharacterData = await getCharacterDataForTarget(targetRosterId);
    goldPopoverTarget = { rosterId: targetRosterId, characterName };
    const currentExtra = Number((targetCharacterData?.[characterName] as CharacterBossData)?._extraGold || 0);
    goldBonusInput = String(Math.max(0, Math.floor(currentExtra)));
    await tick();
    goldBonusInputRef?.focus();
    goldBonusInputRef?.select();
  }

  async function applyGoldBonus(rosterId: string, characterName: string) {
    const targetRosterId = String(rosterId || '').trim();
    if (loading || !targetRosterId) return;

    const parsed = Number(String(goldBonusInput || '0').trim().replace(',', '.'));
    const safeValue = Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;

    const nextCharacterData = await getCharacterDataForTarget(targetRosterId);
    if (!nextCharacterData[characterName]) {
      nextCharacterData[characterName] = {} as CharacterBossData;
    }

    (nextCharacterData[characterName] as CharacterBossData)._extraGold = safeValue;
    nextCharacterData[characterName] = { ...nextCharacterData[characterName] };
    await persistCharacterDataForTarget(targetRosterId, nextCharacterData);
    goldPopoverTarget = null;
  }

  function startCharacterDrag(event: DragEvent, characterName: string) {
    draggingCharacterName = characterName;
    dragOverCharacterName = null;
    event.dataTransfer?.setData('text/plain', characterName);
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.dropEffect = 'move';
    }
  }

  function onCharacterDragOver(event: DragEvent, characterName: string) {
    if (!draggingCharacterName || draggingCharacterName === characterName) return;
    event.preventDefault();
    dragOverCharacterName = characterName;
  }

  function endCharacterDrag() {
    draggingCharacterName = null;
    dragOverCharacterName = null;
  }

  function moveCharacterInOrder(currentOrder: string[], draggedName: string, targetName: string) {
    const nextOrder = [...currentOrder];
    const draggedIndex = nextOrder.indexOf(draggedName);
    const targetIndex = nextOrder.indexOf(targetName);

    if (draggedIndex < 0 || targetIndex < 0 || draggedIndex === targetIndex) {
      return nextOrder;
    }

    const [dragged] = nextOrder.splice(draggedIndex, 1);
    nextOrder.splice(targetIndex, 0, dragged);
    return nextOrder;
  }

  async function onCharacterDrop(event: DragEvent, targetName: string) {
    event.preventDefault();
    if (loading || !activeRosterId) {
      endCharacterDrag();
      return;
    }

    const draggedFromTransfer = event.dataTransfer?.getData('text/plain') || '';
    const draggedName = String(draggingCharacterName || draggedFromTransfer || '').trim();
    const safeTarget = String(targetName || '').trim();

    if (!draggedName || !safeTarget || draggedName === safeTarget) {
      endCharacterDrag();
      return;
    }

    const nextOrder = moveCharacterInOrder(order, draggedName, safeTarget);
    const changed = nextOrder.length === order.length && nextOrder.some((name, index) => name !== order[index]);
    if (!changed) {
      endCharacterDrag();
      return;
    }

    order = nextOrder;
    await persistRoster();
    notifyRosterChanged();
    endCharacterDrag();
  }

  async function toggleRosterDaily(rosterId: string, key: 'fieldBoss' | 'chaosGate' | 'thaemine') {
    const targetRosterId = String(rosterId || '').trim();
    if (loading || !targetRosterId) return;

    const {
      rosterState,
      orderState,
      dailyState,
    } = await getDailyStateForTarget(targetRosterId);

    const current = dailyState.roster?.[key] || defaultActivity();
    const nextCompleted = !current.completed;

    let fallbackBoss = '';
    if (key === 'fieldBoss') fallbackBoss = 'Sevek Atun';
    else if (key === 'chaosGate') fallbackBoss = 'Chaos Gate';
    else if (key === 'thaemine') fallbackBoss = 'Thaemine, Conqueror of Stars';

    dailyState.roster = {
      ...(dailyState.roster || {
        fieldBoss: defaultActivity(),
        chaosGate: defaultActivity(),
        thaemine: defaultActivity(),
      }),
      [key]: defaultActivity({
        completed: nextCompleted,
        boss: nextCompleted ? fallbackBoss : null,
        timestamp: nextCompleted ? new Date().toISOString() : null,
      }),
    };

    await persistDailyStateForTarget(targetRosterId, rosterState, orderState, dailyState);
  }

  function openColumnsConfig(rosterId = activeRosterId, rosterName = '', sourceHiddenColumns = hiddenColumns) {
    if (loading) return;
    const targetRosterId = String(rosterId || '').trim();
    if (!targetRosterId) return;
    const hidden = new Set(sourceHiddenColumns || []);
    draftVisibleColumns = Object.fromEntries(
      columnEntries.map((entry) => [entry.id, !hidden.has(entry.id)])
    );
    // Load custom columns and populate draft pinned state
    const customState = loadColumns(targetRosterId);
    customColumnsStateByRoster = { ...customColumnsStateByRoster, [targetRosterId]: customState };
    const pinned = new Set(loadPinnedCustomCols(targetRosterId));
    draftPinnedCustomCols = Object.fromEntries(
      orderedColumns(customState)
        .filter((col) => col.scope === 'per-character')
        .map((col) => [col.id, pinned.has(col.id)])
    );
    columnSettingsRosterId = targetRosterId;
    columnSettingsRosterName = String(rosterName || '').trim() || rosterNamesById[targetRosterId] || 'this roster';
    columnSettingsOpen = true;
  }

  function closeColumnsConfig() {
    columnSettingsOpen = false;
    columnSettingsRosterId = '';
    columnSettingsRosterName = '';
    draftPinnedCustomCols = {};
  }

  function toggleDraftColumn(columnId: string, checked: boolean) {
    draftVisibleColumns = {
      ...draftVisibleColumns,
      [columnId]: checked,
    };
  }

  async function saveColumnsConfig() {
    const targetRosterId = String(columnSettingsRosterId || activeRosterId || '').trim();
    if (loading || !targetRosterId) return;
    const nextHidden = columnEntries
      .filter((entry) => !draftVisibleColumns[entry.id])
      .map((entry) => entry.id);

    const loadedSettings = await api.loadSettings?.();
    const safeSettings = (loadedSettings || {}) as SettingsPayload;
    const byRoster = safeSettings.hiddenColumnsByRoster || {};

    const legacyHidden = nextHidden.filter((id) => RAID_CONFIG.some((raid) => raid.id === id));

    const nextSettings: SettingsPayload = {
      ...safeSettings,
      hiddenColumns: nextHidden,
      hiddenBossColumns: legacyHidden,
      hiddenColumnsByRoster: {
        ...byRoster,
        [targetRosterId]: nextHidden,
      },
    };

    await api.saveSettings?.(nextSettings);
    settings = nextSettings;
    if (targetRosterId === activeRosterId) {
      hiddenColumns = nextHidden;
    }

    const card = rosterCardsCache[targetRosterId];
    if (card) {
      rosterCardsCache[targetRosterId] = {
        ...card,
        hiddenColumns: [...nextHidden],
      };
      rosterCardsCache = { ...rosterCardsCache };
    }

    // Save pinned custom columns for the weekly tracker
    const nextPinnedIds = Object.entries(draftPinnedCustomCols)
      .filter(([, v]) => v)
      .map(([id]) => id);
    savePinnedCustomCols(targetRosterId, nextPinnedIds);
    pinnedCustomColsByRoster = { ...pinnedCustomColsByRoster, [targetRosterId]: nextPinnedIds };
    if (!customTabValuesCache[targetRosterId]) {
      customTabValuesCache = { ...customTabValuesCache, [targetRosterId]: loadValues(targetRosterId) };
    }

    columnSettingsOpen = false;
    columnSettingsRosterId = '';
    columnSettingsRosterName = '';
    draftPinnedCustomCols = {};
    showToast(`Columns updated for ${rosterNamesById[targetRosterId] || 'roster'}`, TOAST_TYPES.SUCCESS);
  }

  function mapDifficultyFromRaid(value: unknown): Difficulty {
    const safe = String(value || '').toLowerCase();
    if (safe.includes('nightmare')) return 'Nightmare';
    if (safe.includes('hard')) return 'Hard';
    if (safe.includes('normal')) return 'Normal';
    return 'Solo';
  }

  async function loadFromDatabase(options?: { silent?: boolean; overlay?: boolean; rosterId?: string }) {
    const silent = Boolean(options?.silent);
    const overlay = options?.overlay !== false;
    const targetRosterId = String(options?.rosterId || activeRosterId || '').trim();
    if (!targetRosterId) return 0;
    if (loading) return 0;
    if (overlay) loading = true;
    try {
      const hasDb = await ensureDatabaseReady(silent);
      if (!hasDb) {
        return 0;
      }

      await api.reloadCurrentDatabase?.();

      const raids = await api.getRaids?.();
      if (!Array.isArray(raids)) {
        if (!silent) {
          showToast('No raid data available', TOAST_TYPES.WARNING);
        }
        return 0;
      }

      const period = await api.getWeeklyResetPeriod?.();
      const resetStart = Number(period?.start || 0);
      const resetEnd = Number(period?.end || 0);

      const isActiveTarget = targetRosterId === activeRosterId;
      const rosterPayload = (await api.loadRoster?.(targetRosterId)) as RosterPayload | null;
      const rosterState = (rosterPayload?.roster || {}) as Record<string, RosterCharacter | unknown>;
      const targetCharacterData = (await api.loadCharacterData?.(targetRosterId)) as CharacterDataMap | null;
      const next = { ...(targetCharacterData || {}) } as CharacterDataMap;
      let weeklyRowsInWindow = 0;
      let mappedBossRows = 0;
      let matchedCharacterRows = 0;
      let updatedCells = 0;

      raids.forEach((raid: any) => {
        if (!raid?.cleared) return;

        const fightTime = new Date(raid.fight_start).getTime();
        if (resetStart && resetEnd && !(fightTime >= resetStart && fightTime < resetEnd)) {
          return;
        }
        weeklyRowsInWindow += 1;

        const rawBoss = (BOSS_MAP as Record<string, string>)[String(raid.current_boss || '')]
          || String(raid.current_boss || '');
        const boss = normalizeRaidBossId(rawBoss);
        if (!boss) return;
        mappedBossRows += 1;

        const characterName = String(raid.local_player || '');
        const character = getCharacterFromRoster(rosterState, characterName);
        if (!character || character.visible === false) return;
        matchedCharacterRows += 1;

        if (!next[characterName]) next[characterName] = {} as CharacterBossData;
        const previous = getRaidCell(next, characterName, boss);
        const allowedDifficulties = getAllowedDifficultiesForRoster(rosterState, characterName, boss);
        const mappedDifficulty = mapDifficultyFromRaid(raid.difficulty);
        const resolvedDifficulty = allowedDifficulties.includes(mappedDifficulty)
          ? mappedDifficulty
          : allowedDifficulties[0];

        next[characterName][boss] = {
          ...previous,
          cleared: true,
          difficulty: resolvedDifficulty,
          timestamp: raid.fight_start ? String(raid.fight_start) : previous.timestamp,
        };
        updatedCells += 1;
      });

      await api.saveCharacterData?.(targetRosterId, next);

      if (isActiveTarget) {
        characterData = next;
        await syncDailyFromDatabaseData(false);
      }

      const card = rosterCardsCache[targetRosterId];
      if (card) {
        rosterCardsCache[targetRosterId] = {
          ...card,
          characterData: next,
        };
        rosterCardsCache = { ...rosterCardsCache };
      }

      updateDebugSnapshot('loadFromDatabase:summary', {
        totalRows: Array.isArray(raids) ? raids.length : 0,
        weeklyRowsInWindow,
        mappedBossRows,
        matchedCharacterRows,
        updatedCells,
      });

      if (!silent) {
        if (updatedCells > 0) {
          showToast(`Weekly loaded: ${updatedCells} raid entries updated.`, TOAST_TYPES.SUCCESS);
        } else {
          showToast(
            `No raids updated (window=${weeklyRowsInWindow}, bossMapped=${mappedBossRows}, rosterMatch=${matchedCharacterRows}).`,
            TOAST_TYPES.WARNING
          );
        }
      }

      if (!silent && updatedCells > 0 && targetRosterId === activeRosterId) {
        await tryAutoUploadOnFocusChange();
      }

      return updatedCells;
    } catch (error: any) {
      const reported = await reportError(error, {
        code: ERROR_CODES.WEEKLY.LOAD_FROM_DB_FAILED,
        severity: 'error',
        context: {
          phase: 'loadFromDatabase',
          action: 'load-weekly-from-database',
          rosterId: targetRosterId,
          activeRosterId,
        },
        showToast: false,
      });
      if (!silent) {
        showToast(reported.message, TOAST_TYPES.ERROR);
      }
      return 0;
    } finally {
      if (overlay) {
        loading = false;
      }
    }
  }

  async function resetWeekly() {
    await resetWeeklyForRoster(activeRosterId);
  }

  async function resetWeeklyForRoster(targetRosterId: string) {
    const rosterId = String(targetRosterId || '').trim();
    if (loading || !rosterId) return;

    const isActiveTarget = rosterId === activeRosterId;
    const currentCharacterData = isActiveTarget
      ? characterData
      : (((await api.loadCharacterData?.(rosterId)) as CharacterDataMap | null) || {});

    const hiddenStates = preserveHiddenStates(currentCharacterData || {});
    const next = {} as CharacterDataMap;
    restoreHiddenStates(next, hiddenStates);

    const rosterPayload = (await api.loadRoster?.(rosterId)) as RosterPayload | null;
    const rosterState = { ...((rosterPayload?.roster || {}) as Record<string, unknown>) };
    const orderState = [...((rosterPayload?.order || Object.keys(rosterState)) as string[])];
    const nextDailyData = buildDefaultDailyDataForRosterFrom(rosterState, orderState);
    const nextRosterState = {
      ...rosterState,
      dailyData: nextDailyData,
    };

    await Promise.all([
      api.saveCharacterData?.(rosterId, next),
      api.saveRoster?.(rosterId, {
        roster: nextRosterState,
        order: orderState,
      }),
    ]);

    if (isActiveTarget) {
      characterData = next;
      dailyData = nextDailyData;
      roster = nextRosterState as any;
    }

    const card = rosterCardsCache[rosterId];
    if (card) {
      rosterCardsCache[rosterId] = {
        ...card,
        characterData: next,
        dailyData: nextDailyData,
        roster: nextRosterState,
        order: orderState,
      };
      rosterCardsCache = { ...rosterCardsCache };
    }

    showToast(`Weekly data reset for ${rosterNamesById[rosterId] || 'roster'}`, TOAST_TYPES.SUCCESS);
  }

  async function resetDaily() {
    if (loading || !activeRosterId) return;
    if (!window.confirm('Reset daily data now?')) return;
    dailyData = buildDefaultDailyDataForRoster();

    roster = {
      ...roster,
      dailyData,
    };
    await persistRoster();
    showToast('Daily data reset', TOAST_TYPES.SUCCESS);
  }

  async function toggleCharacterDaily(
    rosterId: string,
    characterName: string,
    key: 'guardianRaid' | 'chaosDungeon',
    checked: boolean
  ) {
    const targetRosterId = String(rosterId || '').trim();
    if (loading || !targetRosterId) return;

    const {
      rosterState,
      orderState,
      dailyState,
    } = await getDailyStateForTarget(targetRosterId);

    dailyState.characters[characterName] = {
      ...(dailyState.characters[characterName] || {
        guardianRaid: defaultActivity(),
        chaosDungeon: defaultActivity(),
      }),
      [key]: defaultActivity({
        completed: checked,
        boss: checked ? (key === 'guardianRaid' ? 'Guardian Raid' : 'Chaos Dungeon') : null,
        timestamp: checked ? new Date().toISOString() : null,
      }),
    };

    await persistDailyStateForTarget(targetRosterId, rosterState, orderState, dailyState);
  }

  async function syncDailyFromDatabaseData(showSuccessToast = true) {
    if (!dailyData) return;
    if (visibleCharacters.length === 0) return;

    try {
      const hasDb = await ensureDatabaseReady(!showSuccessToast);
      if (!hasDb) {
        return;
      }

      for (const characterName of visibleCharacters) {
        const guardianHit = await api.getDailyGuardianRaids?.(characterName);
        const guardianActivity = normalizeApiActivity(guardianHit, 'Guardian Raid');
        const currentCharacter = dailyData.characters[characterName] || {
          guardianRaid: defaultActivity(),
          chaosDungeon: defaultActivity(),
        };

        dailyData.characters[characterName] = {
          ...currentCharacter,
          guardianRaid: guardianActivity.completed ? guardianActivity : currentCharacter.guardianRaid,
        };
      }

      const rosterNames = [...visibleCharacters];
      const [fieldBossHit, chaosGateHit, thaemineHit] = await Promise.all([
        api.getDailyFieldBoss?.(rosterNames),
        api.getDailyChaosGate?.(rosterNames),
        api.getWeeklyThaemine?.(rosterNames),
      ]);

      const fieldBossActivity = normalizeApiActivity(fieldBossHit, 'Sevek Atun');
      const chaosGateActivity = normalizeApiActivity(chaosGateHit, 'Chaos Gate');
      const thaemineActivity = normalizeApiActivity(thaemineHit, 'Thaemine, Conqueror of Stars');

      const currentRosterDaily = dailyData.roster || {
        fieldBoss: defaultActivity(),
        chaosGate: defaultActivity(),
        thaemine: defaultActivity(),
      };

      dailyData.roster = {
        fieldBoss: fieldBossActivity.completed ? fieldBossActivity : currentRosterDaily.fieldBoss,
        chaosGate: chaosGateActivity.completed ? chaosGateActivity : currentRosterDaily.chaosGate,
        thaemine: thaemineActivity.completed ? thaemineActivity : currentRosterDaily.thaemine,
      };

      roster = { ...roster, dailyData };
      await persistRoster();

      if (showSuccessToast) {
        showToast('Daily data synced from database', TOAST_TYPES.SUCCESS);
      }
    } catch (error: any) {
      const reported = await reportError(error, {
        code: ERROR_CODES.WEEKLY.LOAD_FROM_DB_FAILED,
        severity: 'error',
        context: {
          phase: 'syncDailyFromDatabaseData',
          action: 'sync-daily-from-database',
          rosterId: activeRosterId,
          activeRosterId,
          visibleCharactersCount: visibleCharacters.length,
        },
        showToast: false,
      });
      if (showSuccessToast) {
        showToast(reported.message, TOAST_TYPES.ERROR);
      }
    }
  }

  async function syncDailyFromDatabase() {
    if (loading || !activeRosterId) return;

    if (visibleCharacters.length === 0) {
      showToast('No visible characters to sync daily data', TOAST_TYPES.WARNING);
      return;
    }

    loading = true;
    try {
      await syncDailyFromDatabaseData(true);
    } finally {
      loading = false;
    }
  }

  function getCharacterGoldForCard(characterName: string, cardCharacterData: CharacterDataMap, cardVisibleBosses: string[]) {
    let total = 0;

    cardVisibleBosses.forEach((boss) => {
      const raid = getRaidConfigByBoss(boss);
      if (!raid) return;

      const cell = getRaidCell(cardCharacterData, characterName, boss);
      const diff = cell.difficulty === 'Nightmare'
        ? 'nmr'
        : (cell.difficulty === 'Hard' ? 'hm' : 'nm');
      const chestCost = Number((raid as any).chest?.[diff] || 0);
      const chestOpenCount = Math.max(0, Math.floor(Number(cell.chestOpenCount || 0)));
      const totalChestCost = chestCost * chestOpenCount;

      if (!cell.cleared) return;

      if (cell.hidden) {
        if (chestOpenCount > 0) {
          total -= totalChestCost;
        }
        return;
      }

      const goldValue = Number((raid as any).gold?.[diff] || 0);
      total += goldValue - totalChestCost;
    });

    const extra = Number((cardCharacterData?.[characterName] as CharacterBossData | undefined)?._extraGold || 0);
    return total + extra;
  }

  function computeGoldByCharacterForCard(
    names: string[],
    cardCharacterData: CharacterDataMap,
    cardVisibleBosses: string[]
  ) {
    const next: Record<string, number> = {};
    names.forEach((characterName) => {
      next[characterName] = getCharacterGoldForCard(characterName, cardCharacterData, cardVisibleBosses);
    });
    return next;
  }

  async function startTimer() {
    const updateTimer = async () => {
      try {
        const period = await api.getWeeklyResetPeriod?.();
        const end = Number(period?.end || 0);
        if (!end) {
          timerText = 'Weekly Reset: --:--:--';
          return;
        }

        const remaining = Math.max(0, end - Date.now());
        const days = Math.floor(remaining / (1000 * 60 * 60 * 24));
        const hours = Math.floor((remaining % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
        const minutes = Math.floor((remaining % (1000 * 60 * 60)) / (1000 * 60));
        const seconds = Math.floor((remaining % (1000 * 60)) / 1000);

        timerText = `Weekly Reset: ${days}d ${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
      } catch {
        timerText = 'Weekly Reset: --:--:--';
      }
    };

    await updateTimer();
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = setInterval(updateTimer, 1000);
  }

  function getRosterDailyTooltip(key: 'fieldBoss' | 'chaosGate' | 'thaemine') {
    return buildDailyTooltip(dailyData?.roster?.[key]);
  }

  function getRosterDailyTooltipFrom(data: DailyData | null | undefined, key: 'fieldBoss' | 'chaosGate' | 'thaemine') {
    return buildDailyTooltip(data?.roster?.[key]);
  }

  function getCharacterDailyTooltip(characterName: string, key: 'guardianRaid' | 'chaosDungeon') {
    return buildDailyTooltip(dailyData?.characters?.[characterName]?.[key]);
  }

  function getCharacterDailyTooltipFrom(
    data: DailyData | null | undefined,
    characterName: string,
    key: 'guardianRaid' | 'chaosDungeon'
  ) {
    return buildDailyTooltip(data?.characters?.[characterName]?.[key]);
  }
</script>

<section class="tab-content active" id="weekly-tab">
  <div id="weekly-cards" class="weekly-cards">
    {#if weeklyCards.length === 0}
      <article class="weekly-card" data-roster-id="__fallback__">
        <div class="weekly-header-block">
          <h1 class="weekly-title">Weekly Tracker</h1>
        </div>

        <div class="friends-empty" style="min-width: 420px; padding: 12px 0;">
          {#if loading}
            Loading weekly data...
          {:else}
            Weekly cards are empty.
            {#if apiReadyStatus === 'timeout'}
              API readiness timed out.
            {:else if apiReadyStatus === 'error'}
              API readiness failed.
            {/if}
          {/if}
        </div>

        <div class="weekly-actions" style="margin-top: 8px;">
          <div class="weekly-actions-left">
            <button type="button" class="header-icon-btn weekly-action-btn" on:click={loadAll} disabled={loading}>
              <img src="./assets/icons/items/download.svg" alt="" aria-hidden="true" />
              <span class="btn-label">Retry Load</span>
            </button>
            <button type="button" class="header-icon-btn weekly-action-btn" on:click={copyWeeklyDebugSnapshot}>
              <span class="btn-label">Copy Debug</span>
            </button>
          </div>
        </div>

        <details style="margin-top: 8px;">
          <summary>Debug snapshot</summary>
          <pre style="white-space: pre-wrap; max-width: 700px;">{JSON.stringify(debugSnapshot, null, 2)}</pre>
        </details>
      </article>
    {/if}

    {#each weeklyCards as card (card.rosterId)}
      {@const cardVisibleBosses = RAID_CONFIG
        .map((raid) => String((raid as any).id || '').trim())
        .filter((bossId) => Boolean(bossId) && !card.hiddenColumns.includes(bossId))}
      {@const cardShowGoldColumn = !card.hiddenColumns.includes('gold')}
      {@const cardShowGuardianColumn = !card.hiddenColumns.includes('guardianRaid')}
      {@const cardShowChaosColumn = !card.hiddenColumns.includes('chaosDungeon')}
      {@const cardCustomColsState = customColumnsStateByRoster[card.rosterId] ?? { columns: [], columnOrder: [] }}
      {@const cardPinnedCustomColIds = new Set(pinnedCustomColsByRoster[card.rosterId] ?? [])}
      {@const cardVisibleCustomCols = orderedColumns(cardCustomColsState).filter((col) => col.scope === 'per-character' && cardPinnedCustomColIds.has(col.id))}
      {@const cardCustomValues = customTabValuesCache[card.rosterId] ?? { perCharacter: {}, global: {} }}
      {@const cardTotalColumnsCount = 1 + cardVisibleBosses.length + (cardShowGoldColumn ? 1 : 0) + (cardShowGuardianColumn ? 1 : 0) + (cardShowChaosColumn ? 1 : 0) + cardVisibleCustomCols.length}
      {@const cardVisibleCharacters = getVisibleCharactersForRoster(card.roster, card.order)}
      {@const cardGoldByCharacter = computeGoldByCharacterForCard(cardVisibleCharacters, card.characterData, cardVisibleBosses)}
      {@const cardTotalGold = Object.values(cardGoldByCharacter).reduce((sum, value) => sum + value, 0)}
      {@const cardDailyData = card.isActive ? dailyData : card.dailyData}

      <article class="weekly-card" data-roster-id={card.rosterId}>
        <div class="weekly-header-block">
          <div class="weekly-top-row">
            <div class="weekly-top-left">
              <h1 class="weekly-title">{card.rosterName}</h1>
              <div class="roster-dailies" aria-label="Roster dailies">
                <button
                  type="button"
                  class="roster-daily-btn no-border large-icon"
                  class:completed={Boolean(cardDailyData?.roster?.thaemine?.completed)}
                  title={getRosterDailyTooltipFrom(cardDailyData, 'thaemine') || 'Extreme Thaemine'}
                  aria-label={cardDailyData?.roster?.thaemine?.completed ? 'Toggle Thaemine' : 'Extreme Thaemine'}
                  on:click={() => toggleRosterDaily(card.rosterId, 'thaemine')}
                >
                  {#if cardDailyData?.roster?.thaemine?.completed}
                    <img src="./assets/icons/items/thaedone.png" alt="" aria-hidden="true" />
                  {:else}
                    <img src="./assets/icons/items/thaeundone.png" alt="" aria-hidden="true" />
                  {/if}
                </button>

                <button
                  type="button"
                  class="roster-daily-btn"
                  class:completed={Boolean(cardDailyData?.roster?.fieldBoss?.completed)}
                  title={getRosterDailyTooltipFrom(cardDailyData, 'fieldBoss') || 'Toggle Field Boss'}
                  aria-label="Toggle Field Boss"
                  on:click={() => toggleRosterDaily(card.rosterId, 'fieldBoss')}
                >
                  <img src="./assets/icons/items/field_boss_icon.webp" alt="" aria-hidden="true" />
                  <span class="roster-daily-check">✓</span>
                </button>

                <button
                  type="button"
                  class="roster-daily-btn"
                  class:completed={Boolean(cardDailyData?.roster?.chaosGate?.completed)}
                  title={getRosterDailyTooltipFrom(cardDailyData, 'chaosGate') || 'Toggle Chaos Gate'}
                  aria-label="Toggle Chaos Gate"
                  on:click={() => toggleRosterDaily(card.rosterId, 'chaosGate')}
                >
                  <img src="./assets/icons/items/chaos_gate_icon.webp" alt="" aria-hidden="true" />
                  <span class="roster-daily-check">✓</span>
                </button>
              </div>
            </div>
          </div>

          <div class="weekly-actions" style="margin-bottom: 12px;">
            <div class="weekly-actions-left">
              <button
                type="button"
                class="header-icon-btn weekly-columns-btn"
                aria-label="Configure raid columns"
                title="Configure raid columns"
                on:click={() => openColumnsConfig(card.rosterId, card.rosterName, card.hiddenColumns)}
              >⚙️</button>
              {#if (card.order?.length ?? 0) > 0}
              <button
                type="button"
                class="header-icon-btn weekly-action-btn weekly-refresh-btn"
                class:is-refreshing={Boolean(refreshingRosterIds[card.rosterId])}
                class:cooldown-active={(refreshCooldownByRoster[card.rosterId] || 0) > 0 && !refreshingRosterIds[card.rosterId]}
                title={refreshingRosterIds[card.rosterId]
                  ? 'Refreshing roster from Bible API…'
                  : (refreshCooldownByRoster[card.rosterId] || 0) > 0
                    ? `Please wait ${refreshCooldownByRoster[card.rosterId]}s before refreshing again`
                    : 'Refresh roster from Bible API'}
                aria-label="Refresh roster from Bible API"
                aria-busy={Boolean(refreshingRosterIds[card.rosterId])}
                on:click={() => handleRefreshWeeklyRoster(card.rosterId)}
                disabled={loading || Boolean(refreshingRosterIds[card.rosterId]) || (refreshCooldownByRoster[card.rosterId] || 0) > 0}
              >
                <svg class="weekly-refresh-icon" width="18" height="18" viewBox="-0.45 0 60.369 60.369" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                  <g transform="translate(-446.571 -211.615)">
                    <path d="M504.547,265.443h-9.019a30.964,30.964,0,0,0-29.042-52.733,1.5,1.5,0,1,0,.792,2.894,27.955,27.955,0,0,1,25.512,48.253l0-10.169h-.011a1.493,1.493,0,0,0-2.985,0h0v13.255a1.5,1.5,0,0,0,1.5,1.5h13.256a1.5,1.5,0,1,0,0-3Z" fill="currentColor"/>
                    <path d="M485.389,267.995a27.956,27.956,0,0,1-25.561-48.213l0,10.2h.015a1.491,1.491,0,0,0,2.978,0h.007V216.791a1.484,1.484,0,0,0-1.189-1.532l-.018-.005a1.533,1.533,0,0,0-.223-.022c-.024,0-.046-.007-.07-.007H448.071a1.5,1.5,0,0,0,0,3h8.995a30.963,30.963,0,0,0,29.115,52.664,1.5,1.5,0,0,0-.792-2.894Z" fill="currentColor"/>
                  </g>
                </svg>
                <span class="btn-label">
                  {#if refreshingRosterIds[card.rosterId]}Refreshing{:else if (refreshCooldownByRoster[card.rosterId] || 0) > 0}Wait {refreshCooldownByRoster[card.rosterId]}s{:else}Refresh{/if}
                </span>
              </button>
              {/if}
              <button type="button" class="header-icon-btn weekly-action-btn" on:click={() => loadFromDatabase({ rosterId: card.rosterId })} disabled={loading}>
                <img src="./assets/icons/items/download.svg" alt="" aria-hidden="true" />
                <span class="btn-label">Load Data</span>
              </button>
              <button
                type="button"
                class="header-icon-btn weekly-action-btn"
                on:click={() => openWeeklyConfirm('reset-weekly', card.rosterId, card.rosterName)}
                disabled={loading}
              >
                <img src="./assets/icons/refresh.svg" alt="" aria-hidden="true" />
                <span class="btn-label">Reset Data</span>
              </button>
            </div>
            <div class="weekly-actions-right">
              {#if card.isActive}
                <div class="reset-timer" aria-live="polite">{timerText}</div>
              {/if}
            </div>
          </div>
        </div>

        <table class="tracker-table">
          <thead>
            <tr>
              <th>Character</th>
              {#each cardVisibleBosses as boss (boss)}
                <th>{getRaidLabel(boss)}</th>
              {/each}
              {#if cardShowGoldColumn}
                <th>Gold</th>
              {/if}
              {#if cardShowGuardianColumn}
                <th class="daily-header daily-divider">Guardian Raid</th>
              {/if}
              {#if cardShowChaosColumn}
                <th class="daily-header" class:daily-divider={!cardShowGuardianColumn}><span>Chaos Dungeon</span><span class="daily-subtext">(manual)</span></th>
              {/if}
              {#each cardVisibleCustomCols as customCol (customCol.id)}
                <th class="custom-weekly-col-header custom-weekly-col-header--{customCol.type}" style={customCol.color ? `border-bottom-color: ${customCol.color}` : ''}>
                  <span class="custom-weekly-col-title-row">
                    <span>{customCol.title}</span>
                    {#if customCol.type === 'text' || customCol.type === 'textarea'}
                      {#if editingWidthColId === customCol.id && editingWidthRosterId === card.rosterId}
                        <input
                          type="text"
                          maxlength="2"
                          inputmode="numeric"
                          class="custom-weekly-width-input"
                          value={editingWidthDraft}
                          on:input={(e) => { const n = parseInt((e.currentTarget as HTMLInputElement).value, 10); if (!isNaN(n)) editingWidthDraft = Math.max(3, Math.min(14, n)); }}
                          on:keydown={(e) => { if (e.key === 'Enter') commitWidthEdit(); else if (e.key === 'Escape') cancelWidthEdit(); }}
                          on:blur={commitWidthEdit}
                          use:focusOnMount
                        />
                      {:else}
                        <button type="button" class="custom-weekly-width-btn" title="Adjust column width" on:click={() => openWidthEditor(card.rosterId, customCol.id, getColWidth(card.rosterId, customCol.id))}>↔</button>
                      {/if}
                    {/if}
                  </span>
                </th>
              {/each}
            </tr>
          </thead>
          <tbody>
            {#if cardVisibleCharacters.length === 0}
              <tr>
                <td colspan={cardTotalColumnsCount} class="friends-empty">No visible characters in roster.</td>
              </tr>
            {/if}

            {#each cardVisibleCharacters as characterName (characterName)}
              {@const character = getCharacterFromRoster(card.roster, characterName)}
              {@const classIconPath = character ? getClassIconPath(character.class) : null}
              {#if character}
                <tr
                  draggable={card.isActive}
                  class:dragging-row={card.isActive && draggingCharacterName === characterName}
                  class:drag-over-row={card.isActive && dragOverCharacterName === characterName}
                  on:dragstart={(event) => card.isActive && startCharacterDrag(event, characterName)}
                  on:dragover={(event) => card.isActive && onCharacterDragOver(event, characterName)}
                  on:drop={(event) => card.isActive && onCharacterDrop(event, characterName)}
                  on:dragend={() => card.isActive && endCharacterDrag()}
                >
                  <td class="char-cell">
                    <div class="char-name" title={characterName}>
                      <span class="char-name-text">{characterName}</span>
                      {#if classIconPath}
                        <img src={classIconPath} alt={character.class} width="28" height="28" />
                      {/if}
                    </div>
                    <div class="char-info">
                      <span class="char-class">{character.class}</span>
                      <span class="char-ilvl">({formatItemLevelDisplay(character.ilvl)})</span>
                    </div>
                  </td>

                  {#each cardVisibleBosses as boss (boss)}
                    {@const eligible = isEligibleForRoster(card.roster, characterName, boss)}
                    {@const cell = getRaidCell(card.characterData, characterName, boss)}
                    <td class="boss-cell">
                      {#if !eligible}
                        <span style="color:#888;">-</span>
                      {:else}
                        <div class="cell" class:cell-hidden={cell.hidden}>
                          <button
                            type="button"
                            class={`difficulty-box ${cell.difficulty.toLowerCase()}`}
                            class:inactive={!cell.cleared}
                            on:click={() => cycleDifficulty(card.rosterId, characterName, boss)}
                            style={`visibility: ${cell.cleared ? 'visible' : 'hidden'}`}
                            title="Cycle difficulty"
                            disabled={!cell.cleared}
                          >
                            {cell.difficulty}
                          </button>

                          <input
                            type="checkbox"
                            class="checkmark"
                            checked={cell.cleared}
                            title={cell.timestamp ? formatTimestamp(cell.timestamp) : ''}
                            on:change={(event) => toggleRaid(card.rosterId, characterName, boss, Boolean((event.currentTarget as HTMLInputElement).checked))}
                            aria-label={`Toggle ${boss} for ${characterName}`}
                          />

                          <span
                            class="eye-icon"
                            role="button"
                            tabindex="0"
                            title="Hide from gold"
                            on:click={() => toggleHidden(card.rosterId, characterName, boss)}
                            on:keydown={(event) => (event.key === 'Enter' || event.key === ' ') && toggleHidden(card.rosterId, characterName, boss)}
                          >👁</span>

                          <span
                            class="chest-icon"
                            class:active={cell.chestOpened}
                            class:double={cell.chestOpenCount > 1}
                            role="button"
                            tabindex="0"
                            title={cell.chestOpenCount > 1 ? 'Chest opened 2x' : (cell.chestOpened ? 'Chest opened' : 'Chest closed')}
                            on:click={() => toggleChest(card.rosterId, characterName, boss)}
                            on:keydown={(event) => (event.key === 'Enter' || event.key === ' ') && toggleChest(card.rosterId, characterName, boss)}
                          >
                            {#if cell.chestOpenCount > 1}
                              <span class="chest-open-count-badge" aria-hidden="true">{cell.chestOpenCount}</span>
                            {/if}
                          </span>
                        </div>
                      {/if}
                    </td>
                  {/each}

                  {#if cardShowGoldColumn}
                    <td class="gold-cell">
                      <div class="gold-display">
                        <span class="gold-icon" aria-hidden="true"></span>
                        <span class="gold-amount">{Number(cardGoldByCharacter[characterName] || 0).toLocaleString()}</span>
                        <button
                          type="button"
                          class="gold-bonus-handle"
                          title="Add bonus gold"
                          aria-label={`Add bonus gold for ${characterName}`}
                          on:click|stopPropagation={() => openGoldBonus(card.rosterId, characterName)}
                        >+
                        </button>

                        {#if goldPopoverTarget && goldPopoverTarget.rosterId === card.rosterId && goldPopoverTarget.characterName === characterName}
                          <div class="gold-bonus-popover">
                            <input
                              class="gold-bonus-input"
                              type="number"
                              min="0"
                              step="10"
                              bind:value={goldBonusInput}
                              bind:this={goldBonusInputRef}
                              aria-label="Extra gold"
                              on:mousedown|stopPropagation
                              on:keydown={(event) => event.key === 'Enter' && applyGoldBonus(card.rosterId, characterName)}
                            />
                            <button type="button" class="gold-bonus-confirm primary" on:mousedown|stopPropagation on:click={() => applyGoldBonus(card.rosterId, characterName)}>OK</button>
                          </div>
                        {/if}
                      </div>
                    </td>
                  {/if}

                  {#if cardShowGuardianColumn}
                    <td class="daily-cell daily-divider">
                      <input
                        type="checkbox"
                        class="daily-checkmark"
                        checked={Boolean(cardDailyData?.characters?.[characterName]?.guardianRaid?.completed)}
                        title={getCharacterDailyTooltipFrom(cardDailyData, characterName, 'guardianRaid')}
                        on:change={(event) => toggleCharacterDaily(card.rosterId, characterName, 'guardianRaid', Boolean((event.currentTarget as HTMLInputElement).checked))}
                        aria-label={`Guardian raid completed for ${characterName}`}
                      />
                    </td>
                  {/if}

                  {#if cardShowChaosColumn}
                    <td class="daily-cell" class:daily-divider={!cardShowGuardianColumn}>
                      <input
                        type="checkbox"
                        class="daily-checkmark"
                        checked={Boolean(cardDailyData?.characters?.[characterName]?.chaosDungeon?.completed)}
                        title={getCharacterDailyTooltipFrom(cardDailyData, characterName, 'chaosDungeon')}
                        on:change={(event) => toggleCharacterDaily(card.rosterId, characterName, 'chaosDungeon', Boolean((event.currentTarget as HTMLInputElement).checked))}
                        aria-label={`Chaos dungeon completed for ${characterName}`}
                      />
                    </td>
                  {/if}

                  {#each cardVisibleCustomCols as customCol (customCol.id)}
                    <td class="custom-weekly-col-cell custom-weekly-col-cell--{customCol.type}">
                      {#if customCol.type === 'checkbox'}
                        <input
                          type="checkbox"
                          class="daily-checkmark"
                          checked={Boolean(getCellValue(cardCustomValues, customCol, characterName))}
                          on:change={(event) => setWeeklyCustomCellValue(card.rosterId, customCol, characterName, Boolean((event.currentTarget as HTMLInputElement).checked))}
                          aria-label={`${customCol.title} for ${characterName}`}
                        />
                      {:else if customCol.type === 'counter'}
                        <div class="custom-weekly-counter-widget" role="group" aria-label={`${customCol.title} for ${characterName}`}>
                          <button type="button" class="custom-weekly-counter-btn" aria-label={`Decrease ${customCol.title}`} on:click={() => setWeeklyCustomCellValue(card.rosterId, customCol, characterName, (Number(getCellValue(cardCustomValues, customCol, characterName)) || 0) - 1)}>−</button>
                          <input
                            type="number"
                            class="custom-weekly-counter-input"
                            value={Number(getCellValue(cardCustomValues, customCol, characterName) ?? 0)}
                            on:input={(event) => { const n = parseInt((event.currentTarget as HTMLInputElement).value, 10); setWeeklyCustomCellValue(card.rosterId, customCol, characterName, Number.isFinite(n) ? n : 0); }}
                            aria-label={`${customCol.title} for ${characterName}`}
                          />
                          <button type="button" class="custom-weekly-counter-btn" aria-label={`Increase ${customCol.title}`} on:click={() => setWeeklyCustomCellValue(card.rosterId, customCol, characterName, (Number(getCellValue(cardCustomValues, customCol, characterName)) || 0) + 1)}>+</button>
                        </div>
                      {:else}
                        {@const colWidth = customColWidthsByRoster[card.rosterId]?.[customCol.id] ?? 5}
                        <input
                          type="text"
                          class="custom-weekly-input custom-weekly-text"
                          value={String(getCellValue(cardCustomValues, customCol, characterName) ?? '')}
                          size={Math.max(colWidth, String(getCellValue(cardCustomValues, customCol, characterName) ?? '').length)}
                          on:input={(event) => { const el = event.currentTarget as HTMLInputElement; el.size = Math.max(colWidth, el.value.length); }}
                          on:change={(event) => setWeeklyCustomCellValue(card.rosterId, customCol, characterName, (event.currentTarget as HTMLInputElement).value)}
                          aria-label={`${customCol.title} for ${characterName}`}
                        />
                      {/if}
                    </td>
                  {/each}
                </tr>
              {/if}
            {/each}

            {#if cardVisibleCharacters.length > 0 && cardShowGoldColumn}
              <tr class="total-row">
                <td class="total-label">Total Gold</td>
                {#each cardVisibleBosses as bossId (bossId)}
                  <td class="total-empty"></td>
                {/each}
                <td class="gold-cell">
                  <div class="gold-display">
                    <span class="gold-icon" aria-hidden="true"></span>
                    <span class="gold-amount">{cardTotalGold.toLocaleString()}</span>
                  </div>
                </td>
                {#if cardShowGuardianColumn}
                  <td class="total-empty"></td>
                {/if}
                {#if cardShowChaosColumn}
                  <td class="total-empty"></td>
                {/if}
                {#each cardVisibleCustomCols as customCol (customCol.id)}
                  <td class="total-empty"></td>
                {/each}
              </tr>
            {/if}
          </tbody>
        </table>

        {#if columnSettingsOpen && columnSettingsRosterId === card.rosterId}
          {@const modalCustomColsState = customColumnsStateByRoster[columnSettingsRosterId] ?? { columns: [], columnOrder: [] }}
          {@const modalPerCharCols = orderedColumns(modalCustomColsState).filter((col) => col.scope === 'per-character')}
          <div id="column-settings-modal" style="display: block;" role="dialog" aria-modal="true" aria-labelledby="column-settings-title">
            <div class="modal-overlay"></div>
            <div class="modal-content column-settings-modal" role="document">
              <button id="column-settings-close" class="close-btn" aria-label="Close column settings" on:click={closeColumnsConfig}>×</button>
              <h2 id="column-settings-title" style="margin-top: 0;">Table Columns</h2>
              <p class="modal-subtitle">Choose which columns appear in the Weekly Tracker (raids, gold, guardian raid, chaos dungeon). Hidden columns will not count toward gold.</p>

              <div id="column-settings-list" class="column-settings-list">
                {#each columnEntries as entry (entry.id)}
                  <label class="column-settings-item">
                    <input
                      type="checkbox"
                      checked={Boolean(draftVisibleColumns[entry.id])}
                      on:change={(event) => toggleDraftColumn(entry.id, Boolean((event.currentTarget as HTMLInputElement).checked))}
                    />
                    <div class="column-settings-copy">
                      <span class="column-settings-title">{entry.label}</span>
                      <span class="column-settings-sub">{entry.subtitle}</span>
                    </div>
                  </label>
                {/each}

                {#if modalPerCharCols.length > 0}
                  <p class="column-settings-section-label">Custom Tab Columns</p>
                  <div class="column-settings-custom-grid">
                    {#each modalPerCharCols as col (col.id)}
                      <label class="column-settings-item">
                        <input
                          type="checkbox"
                          checked={Boolean(draftPinnedCustomCols[col.id])}
                          on:change={(event) => toggleDraftPinnedCustomCol(col.id, Boolean((event.currentTarget as HTMLInputElement).checked))}
                        />
                        <div class="column-settings-copy">
                          <span class="column-settings-title">{col.title}</span>
                          <span class="column-settings-sub">{col.type} · per character</span>
                        </div>
                      </label>
                    {/each}
                  </div>
                {/if}
              </div>

              <div class="modal-buttons">
                <button id="column-settings-save" on:click={saveColumnsConfig}>Save</button>
                <button id="column-settings-cancel" on:click={closeColumnsConfig}>Cancel</button>
              </div>
            </div>
          </div>
        {/if}
      </article>
    {/each}

    {#if weeklyConfirmOpen}
      <div
        class="settings-confirm-overlay"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="weekly-confirm-title"
        aria-describedby="weekly-confirm-description"
        tabindex="0"
        on:click={onWeeklyConfirmOverlayClick}
        on:keydown={onWeeklyConfirmOverlayKeydown}
      >
        <div class="settings-confirm-card" role="document">
          <h3 id="weekly-confirm-title">{weeklyConfirmTitle}</h3>
          <p id="weekly-confirm-description">{weeklyConfirmMessage}</p>
          <div class="settings-confirm-actions">
            <button type="button" bind:this={weeklyConfirmCancelButton} on:click={closeWeeklyConfirm} disabled={loading}>Cancel</button>
            <button type="button" bind:this={weeklyConfirmConfirmButton} class="danger-action-btn" on:click={confirmWeeklyAction} disabled={loading}>Confirm</button>
          </div>
        </div>
      </div>
    {/if}
  </div>
</section>
