<script lang="ts">
  import { onMount } from 'svelte';
  import { UIHelper } from '../../utils/uiHelper';
  import { TOAST_TYPES } from '../../legacy/config/constants.js';
  import { withAsyncError } from '../../utils/errorWrappers';
  import { ERROR_CODES } from '../../utils/errorCodes';
  import DbGuideModal from '../../components/DbGuideModal.svelte';
  import SettingsHeader from './SettingsHeader.svelte';
  import type { AppApi, DbAccessSupport, DbPermissionStatus, SettingsPayload } from '../../../types/app-api';

  /**
   * Database import / permission management UI. Previously lived inside
   * SettingsTrackerSection alongside the onboarding wizard; extracted into
   * its own section so Tracker Integration can focus on the wizard and the
   * database workflow has breathing room under its own nav entry.
   */

  const ui = new UIHelper();
  const api: AppApi = window.api;
  const PERSISTENT_ACCESS_PENDING_KEY = 'wtl:persistent-access-pending-grant';

  let loading = true;
  let dbDragDepth = 0;
  let dropZoneMessage = 'Drag and drop encounters.db here to load it (persistent when allowed).';
  let dropSuccess = false;
  let dropError = false;
  let showReloadPageHighlight = false;
  let showGrantPersistentAccessHighlight = false;
  let dbPermission = 'unknown';
  let dbAccessSupport: DbAccessSupport = {
    persistentHandle: typeof window !== 'undefined' && typeof window.showOpenFilePicker === 'function',
    nativeFilePicker: typeof window !== 'undefined' && typeof window.showOpenFilePicker === 'function',
    handleDragDrop: typeof DataTransferItem !== 'undefined' && 'getAsFileSystemHandle' in DataTransferItem.prototype,
    browser: 'unknown',
  };
  let dbLoadedFile = 'Not loaded';
  let dbLastLoaded = 'Never';
  let dbGuideOpen = false;

  let settings: SettingsPayload = {
    dbPath: '',
    dbLastLoadedAt: null,
    autoRaidUpdateMinutes: 0,
    autoRaidUpdateOnFocus: false,
    timezone: 'browser',
    dateFormat: 'browser',
    timeFormat: 'browser',
    closeToTray: false,
    closeToTrayPrompted: false,
    hiddenColumns: [],
    hiddenColumnsByRoster: {},
    hiddenBossColumns: [],
    visibleWeeklyRosters: [],
    visibleWeeklyRostersByRoster: {},
  };

  $: dropZoneDragover = dbDragDepth > 0;
  $: permissionToneClass = dbPermission.toLowerCase().startsWith('granted')
    ? 'granted'
    : dbPermission.toLowerCase().startsWith('denied')
      ? 'denied'
      : '';
  $: persistentAccessSupported = Boolean(dbAccessSupport?.persistentHandle);
  $: browserName = dbAccessSupport?.browser === 'firefox'
    ? 'Firefox'
    : dbAccessSupport?.browser === 'safari'
      ? 'Safari'
      : dbAccessSupport?.browser === 'brave'
        ? 'Brave'
        : dbAccessSupport?.browser === 'edge'
          ? 'Edge'
          : dbAccessSupport?.browser === 'opera'
            ? 'Opera'
            : dbAccessSupport?.browser === 'chrome'
              ? 'Chrome'
              : dbAccessSupport?.browser === 'chromium'
                ? 'Chromium'
                : 'this browser';

  onMount(async () => {
    await initialize();
  });

  function showToast(message: string, type = TOAST_TYPES.INFO) {
    ui.showToast(message, type);
  }

  function formatLoadedAt(value: number | null | undefined) {
    if (!value) return 'Never';
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return 'Never';
    return parsed.toLocaleString();
  }

  function updateDropZoneStatus(message: string, success = false, error = false) {
    dropZoneMessage = message;
    dropSuccess = success;
    dropError = error;
  }

  function emitSettingsChanged() {
    document.dispatchEvent(new CustomEvent('settingsChanged', { detail: { settings } }));
  }

  async function refreshPermissionStatus() {
    if (!persistentAccessSupported) {
      dbPermission = 'unsupported (session only)';
      return;
    }
    const status = await api.getDatabasePermissionStatus() as DbPermissionStatus;
    dbPermission = status?.hasHandle ? (status.permission || 'unknown') : `${status?.permission || 'unknown'} (no handle)`;
  }

  async function refreshDbAccessSupport() {
    if (!api.getDatabaseAccessSupport) return;
    dbAccessSupport = await api.getDatabaseAccessSupport();
  }

  async function refreshDatabaseStatus() {
    dbLoadedFile = settings.dbPath?.trim() || 'Not loaded';
    dbLastLoaded = formatLoadedAt(settings.dbLastLoadedAt);
    await refreshPermissionStatus();
  }

  function setPendingGrantPersistentAccess(value: boolean) {
    try {
      if (value) {
        sessionStorage.setItem(PERSISTENT_ACCESS_PENDING_KEY, '1');
      } else {
        sessionStorage.removeItem(PERSISTENT_ACCESS_PENDING_KEY);
      }
    } catch {
      /* noop */
    }
  }

  function hasPendingGrantPersistentAccess() {
    try {
      return sessionStorage.getItem(PERSISTENT_ACCESS_PENDING_KEY) === '1';
    } catch {
      return false;
    }
  }

  async function initialize() {
    loading = true;
    try {
      const [loaded] = await Promise.all([
        api.loadSettings(),
        refreshDbAccessSupport(),
      ]);
      settings = { ...settings, ...(loaded || {}) };

      if (settings.dbPath?.trim()) {
        updateDropZoneStatus(`Loaded: ${settings.dbPath} — drag & drop encounters.db here to replace`, true, false);
      } else if (!persistentAccessSupported) {
        updateDropZoneStatus('Drag and drop encounters.db here to load it (session only in this browser).', false, false);
      }

      if (api.restorePersistedHandle) {
        await api.restorePersistedHandle();
      }

      await refreshDatabaseStatus();

      const waitingGrantStep = hasPendingGrantPersistentAccess();
      if (waitingGrantStep) {
        showReloadPageHighlight = false;
        if (!persistentAccessSupported) {
          showGrantPersistentAccessHighlight = false;
          setPendingGrantPersistentAccess(false);
          return;
        }
        const isGrantedNow = String(dbPermission || '').toLowerCase().startsWith('granted');
        showGrantPersistentAccessHighlight = !isGrantedNow;
        if (isGrantedNow) {
          setPendingGrantPersistentAccess(false);
        }
      } else {
        showGrantPersistentAccessHighlight = false;
      }
    } finally {
      loading = false;
    }
  }

  function openDbGuide() {
    dbGuideOpen = true;
  }

  function closeDbGuide() {
    dbGuideOpen = false;
  }

  async function persistLoadedDatabaseName(loadedName: string) {
    settings.dbPath = loadedName;
    settings.dbLastLoadedAt = Date.now();
    await api.saveSettings(settings);
    emitSettingsChanged();
  }

  async function markDatabaseLoaded(options: {
    loadedName: string;
    dropMessage: string;
    toastMessage?: string;
    showReloadHighlight?: boolean;
  }) {
    await persistLoadedDatabaseName(options.loadedName);
    if (options.showReloadHighlight && persistentAccessSupported) {
      showReloadPageHighlight = true;
    } else if (!persistentAccessSupported) {
      showReloadPageHighlight = false;
    }
    updateDropZoneStatus(options.dropMessage, true, false);
    if (options.toastMessage) {
      showToast(options.toastMessage, TOAST_TYPES.SUCCESS);
    }
    await refreshDatabaseStatus();
  }

  async function importDatabaseHandle(handle: FileSystemFileHandle) {
    const isFirstDatabaseLoad = !settings.dbPath?.trim();
    await api.importDatabaseHandle(handle);
    const loadedName = handle?.name || 'encounters.db';
    await markDatabaseLoaded({
      loadedName,
      dropMessage: `Loaded: ${loadedName} (persistent when allowed).`,
      toastMessage: 'Database loaded with persistent access (when allowed).',
      showReloadHighlight: isFirstDatabaseLoad,
    });
  }

  async function importDatabaseFile(file: File) {
    const isFirstDatabaseLoad = !settings.dbPath?.trim();
    await api.importDatabaseFile(file);
    const loadedName = file.name || 'encounters.db';
    await markDatabaseLoaded({
      loadedName,
      dropMessage: `Loaded: ${loadedName} (session only).`,
      toastMessage: 'Database loaded for this session only.',
      showReloadHighlight: isFirstDatabaseLoad,
    });
  }

  async function handleDrop(event: DragEvent) {
    event.preventDefault();
    dbDragDepth = 0;
    const transfer = event.dataTransfer;
    if (!transfer) return;

    const dropResult = await withAsyncError(async () => {
      const items = transfer.items;
      if (items?.length) {
        for (const item of items) {
          if (item.kind !== 'file') continue;
          const handle = item.getAsFileSystemHandle ? await item.getAsFileSystemHandle() : null;
          const fileHandle = handle && handle.kind === 'file' ? handle as FileSystemFileHandle : null;
          if (fileHandle) {
            if (!String(fileHandle.name || '').toLowerCase().endsWith('.db')) {
              updateDropZoneStatus('Please drop a .db file (encounters.db).', false, true);
              showToast('Please drop encounters.db.', TOAST_TYPES.ERROR);
              return;
            }
            await importDatabaseHandle(fileHandle);
            return;
          }
        }
      }

      const file = transfer.files?.[0];
      if (!file) {
        updateDropZoneStatus('No file detected in the drop. Please try again.', false, true);
        return;
      }

      if (!String(file.name || '').toLowerCase().endsWith('.db')) {
        updateDropZoneStatus('Please drop a .db file (encounters.db).', false, true);
        showToast('Please drop encounters.db.', TOAST_TYPES.ERROR);
        return;
      }

      await importDatabaseFile(file);
      return true;
    }, {
      code: ERROR_CODES.DB.READ_FAILED,
      severity: 'error',
      context: { phase: 'SettingsDatabaseSection.handleDrop', action: 'import-db-drop' },
      showToast: true,
    });

    if (dropResult === null) {
      updateDropZoneStatus('Could not read the dropped file.', false, true);
    }
  }

  function handleDropZoneDragEnter(event: DragEvent) {
    event.preventDefault();
    dbDragDepth += 1;
  }

  function handleDropZoneDragLeave(event: DragEvent) {
    event.preventDefault();
    dbDragDepth = Math.max(0, dbDragDepth - 1);
  }

  async function requestPersistentAccess() {
    if (!persistentAccessSupported) {
      showToast(`Persistent file access is unavailable in ${browserName} in this context. Use drag-and-drop each session. For the best experience, please use Chrome, Edge, or Opera.`, TOAST_TYPES.INFO);
      return;
    }
    const result = await api.requestDatabasePermission();
    if (result?.ok) {
      showToast('Persistent access granted.', TOAST_TYPES.SUCCESS);
      showGrantPersistentAccessHighlight = false;
      setPendingGrantPersistentAccess(false);
    }
    else if (result?.reason === 'permission-denied') showToast('Permission denied by the browser.', TOAST_TYPES.ERROR);
    else if (result?.reason === 'unsupported-browser') showToast(`Persistent file access is unavailable in ${browserName} in this context. For the best experience, please use Chrome, Edge, or Opera.`, TOAST_TYPES.INFO);
    else if (result?.reason === 'no-handle') showToast('No remembered database file. Drop encounters.db first.', TOAST_TYPES.INFO);
    else showToast('Could not reconnect the database.', TOAST_TYPES.ERROR);
    await refreshDatabaseStatus();
  }

  function reloadPageNow() {
    showReloadPageHighlight = false;
    setPendingGrantPersistentAccess(true);
    window.location.reload();
  }

  async function reloadDbNow() {
    const result = await api.reloadCurrentDatabase();
    if (!result?.ok) {
      if (result?.reason === 'permission-denied') showToast('Permission denied. Re-grant access and try again.', TOAST_TYPES.ERROR);
      else if (result?.reason === 'no-database') showToast('No database loaded. Drop encounters.db first.', TOAST_TYPES.ERROR);
      else showToast('Could not reload the database.', TOAST_TYPES.ERROR);
      await refreshDatabaseStatus();
      return;
    }

    const loadedName = result.loadedFile || settings.dbPath || 'encounters.db';
    await markDatabaseLoaded({
      loadedName,
      dropMessage: `Loaded: ${loadedName} (reloaded now).`,
      toastMessage: 'Database reloaded.',
    });
  }
</script>

<SettingsHeader title="Database Import" hint="Load encounters.db and manage the browser's file access permission." />

<div class="settings-section settings-section--db">
  <h3>Database</h3>
  <button id="open-db-guide-btn" class="db-guide-btn" type="button" on:click={openDbGuide}>How to find encounters.db?</button>
  <div
    id="db-drop-zone"
    class={`db-drop-zone ${dropSuccess ? 'success' : ''} ${dropError ? 'error' : ''} ${dropZoneDragover ? 'dragover' : ''}`}
    role="region"
    on:dragover|preventDefault
    on:dragenter={handleDropZoneDragEnter}
    on:dragleave={handleDropZoneDragLeave}
    on:drop={handleDrop}
    aria-label="Drop encounters.db here"
  >
    {dropZoneMessage}
  </div>

  <div id="db-copy-progress" class="db-copy-progress" style="display:none;">
    <div id="db-copy-progress-bar" class="db-copy-progress__bar" style="width:0%"></div>
    <span id="db-copy-progress-label" class="db-copy-progress__label">Copying… 0%</span>
  </div>

  <div class="db-status-list" aria-label="Database status">
    <div class="db-status-row">
      <span class="db-status-label">Loaded file</span>
      <span id="db-loaded-file-status" class="db-status-value">{dbLoadedFile}</span>
    </div>
    <div class="db-status-row">
      <span class="db-status-label">Permission status</span>
      <span id="db-permission-status" class={`db-status-value db-permission-status ${permissionToneClass}`}>{dbPermission}</span>
    </div>
    <div class="db-status-row">
      <span class="db-status-label">Last loaded</span>
      <span id="db-last-loaded-status" class="db-status-value">{dbLastLoaded}</span>
    </div>
  </div>

  <div class="db-action-buttons">
    <button id="grant-db-persistent-access-btn" type="button" class:grant-persistent-access-highlight={showGrantPersistentAccessHighlight} on:click={requestPersistentAccess} disabled={loading || !persistentAccessSupported}>Grant persistent access</button>
    <button id="reload-db-now-btn" type="button" on:click={reloadDbNow} disabled={loading}>Reload database now</button>
    <button id="reload-page-now-btn" type="button" class:reload-page-now-highlight={showReloadPageHighlight} on:click={reloadPageNow} disabled={loading}>Reload page now</button>
  </div>

  {#if persistentAccessSupported}
    <p class="db-permission-help">Tip: after the first load, click <strong>Reload page now</strong>. If permission is still blocked after reload, click <strong>Grant persistent access</strong> and accept the browser prompt.</p>
  {:else}
    <p class="db-permission-help">{browserName} does not support persistent file handles in this flow. Load <strong>encounters.db</strong> again whenever a new session starts. For the best experience, please use <strong>Chrome</strong>, <strong>Edge</strong>, or <strong>Opera</strong>.</p>
  {/if}
</div>

<DbGuideModal open={dbGuideOpen} on:close={closeDbGuide} />
