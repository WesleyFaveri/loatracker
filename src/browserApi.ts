import { dbBridge } from './dbBridge';
import type { AppApi } from './types/app-api';

type PermissionResult = 'granted' | 'denied' | 'prompt' | 'unknown';
type DbAccessSupport = Awaited<ReturnType<AppApi['getDatabaseAccessSupport']>>;
type DbPermissionStatus = Awaited<ReturnType<AppApi['getDatabasePermissionStatus']>>;
type DbPermissionRequestResult = Awaited<ReturnType<AppApi['requestDatabasePermission']>>;
type ReloadDbResult = Awaited<ReturnType<AppApi['reloadCurrentDatabase']>>;

type FileSystemFileHandleLike = {
  queryPermission?: (options?: { mode: 'read' }) => Promise<PermissionResult>;
  requestPermission?: (options?: { mode: 'read' }) => Promise<PermissionResult>;
  getFile?: () => Promise<File>;
};

type RosterMeta = {
  id: string;
  name: string;
  createdAt: number;
  characterCount: number;
};

type RosterListState = {
  rosters: RosterMeta[];
  activeRosterId: string | null;
};

type RosterPayload = {
  roster: Record<string, unknown>;
  order: string[];
};

type DbMetaState = {
  size: number | null;
  mtime: number | null;
  changeCounter: number | null;
  name: string;
};

type DailyCompletion = {
  completed: true;
  boss: string;
  timestamp: number;
};

type SettingsPayload = typeof DEFAULT_SETTINGS & Record<string, unknown>;

const STORAGE_KEYS = {
  settings: 'wtl:settings',
  rosterList: 'wtl:roster:list',
  rosterData: (id: string) => `wtl:roster:${id}:data`,
  characterData: (id: string) => `wtl:roster:${id}:characters`,
  paradiseData: (id: string) => `wtl:roster:${id}:paradise`,
  raids: 'wtl:lastRaids',
};

const ROSTER_META_KEYS = new Set(['dailyData']);

const DEFAULT_SETTINGS = {
  dbPath: '',
  dbLastLoadedAt: null,
  timezone: 'browser',
  dateFormat: 'browser',
  timeFormat: 'browser',
  autoRaidUpdateMinutes: 0,
  autoRaidUpdateOnFocus: false,
  closeToTray: false,
  closeToTrayPrompted: false,
  hiddenColumns: [],
  hiddenColumnsByRoster: {},
  hiddenBossColumns: [],
  visibleWeeklyRosters: [],
  visibleWeeklyRostersByRoster: {},
  paradiseBetaUnlocked: false,
  paradiseEnabled: false,
};

const inMemory = new Map<string, unknown>(); // Fallback if localStorage is unavailable
let uploadedDbName = ''; // Friendly label for UI (filename)
let dbMeta: DbMetaState = { size: null, mtime: null, changeCounter: null, name: '' }; // Track file metadata
let currentHandle: FileSystemFileHandleLike | null = null; // Last FileSystemFileHandle used
let currentFile: File | null = null;   // Latest File snapshot (from handle.getFile() or drag-drop)
const HANDLE_DB = 'wtl-db-handle';
const HANDLE_STORE = 'handles';
const HANDLE_KEY = 'encounters-db-handle';
let restoreHandlePromise: Promise<boolean> | null = null;

function detectBrowserFamily(): DbAccessSupport['browser'] {
  const userAgent = String(navigator?.userAgent || '').toLowerCase();
  if ((navigator as { brave?: unknown } | undefined)?.brave) return 'brave';
  if (userAgent.includes('firefox/')) return 'firefox';
  if (userAgent.includes('safari/') && !userAgent.includes('chrome/')) return 'safari';
  if (userAgent.includes('edg/')) return 'edge';
  if (userAgent.includes('opr/')) return 'opera';
  if (userAgent.includes('chrome/')) return 'chrome';
  if (userAgent.includes('chromium/')) return 'chromium';
  return 'unknown';
}

function detectDatabaseAccessSupport(): DbAccessSupport {
  const nativeFilePicker = typeof window.showOpenFilePicker === 'function';
  const itemProto = typeof DataTransferItem !== 'undefined' ? DataTransferItem.prototype as Partial<DataTransferItem> : null;
  const handleDragDrop = Boolean(itemProto && 'getAsFileSystemHandle' in itemProto);
  return {
    persistentHandle: nativeFilePicker,
    nativeFilePicker,
    handleDragDrop,
    browser: detectBrowserFamily(),
  };
}

/** Update display metadata only – does NOT touch the OPFS file or the worker. */
function updateDbMeta(name: string, meta: Partial<DbMetaState> | null | undefined) {
  uploadedDbName = name || 'encounters.db';
  dbMeta = {
    size: meta?.size ?? null,
    mtime: meta?.mtime ?? Date.now(),
    changeCounter: meta?.changeCounter ?? null,
    name: name || meta?.name || 'encounters.db',
  };
}

/**
 * Read the SQLite "file change counter" stored at bytes 24-27 (big-endian uint32)
 * of the database header.  SQLite increments this on every write transaction,
 * making it far more reliable than mtime or file size for change detection.
 * Returns null if the file is too small or unreadable.
 */
async function readSqliteChangeCounter(file: File): Promise<number | null> {
  try {
    const buf = await file.slice(24, 28).arrayBuffer();
    if (buf.byteLength < 4) return null;
    return new DataView(buf).getUint32(0, false); // big-endian
  } catch {
    return null;
  }
}

function readJSON<T>(key: string, fallback: T): T {
  if (inMemory.has(key)) {
    return inMemory.get(key) as T;
  }

  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as T;
    inMemory.set(key, parsed);
    return parsed;
  } catch (err) {
    console.warn('localStorage read failed, using memory fallback', err);
    return (inMemory.get(key) as T | undefined) ?? fallback;
  }
}

function writeJSON(key: string, value: unknown) {
  inMemory.set(key, value);

  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (err) {
    console.warn('localStorage write failed, storing in memory fallback', err);
  }
}

function generateId() {
  if (crypto?.randomUUID) return crypto.randomUUID();
  return `roster-${Math.random().toString(36).slice(2, 10)}`;
}

function getDefaultRosterList() {
  const id = generateId();
  const now = Date.now();
  return {
    rosters: [{ id, name: 'Main Roster', createdAt: now, characterCount: 0 }],
    activeRosterId: id,
  };
}

function ensureRosterList(): RosterListState {
  const existing = readJSON<RosterListState | null>(STORAGE_KEYS.rosterList, null);

  // First run (no stored list): persist a single default roster immediately so
  // subsequent calls reuse the same IDs instead of generating new random ones
  // and losing saved data under a different key.
  if (!existing) {
    const defaults = getDefaultRosterList();
    writeJSON(STORAGE_KEYS.rosterList, defaults);

    // Initialize empty buckets for the default roster to keep storage in sync
    const defaultId = defaults.activeRosterId;
    writeJSON(STORAGE_KEYS.rosterData(defaultId), { roster: {}, order: [] });
    writeJSON(STORAGE_KEYS.characterData(defaultId), {});
    return defaults;
  }

  // Guarantee structure
  if (!Array.isArray(existing.rosters) || !existing.rosters.length || !existing.activeRosterId) {
    const fixed = getDefaultRosterList();
    writeJSON(STORAGE_KEYS.rosterList, fixed);
    return fixed;
  }

  return existing;
}

function setRosterList(list: RosterListState) {
  writeJSON(STORAGE_KEYS.rosterList, list);
}

function getWeeklyResetPeriodValue(now = new Date()) {
  const end = new Date(now);
  const daysUntilWednesday = (3 - end.getUTCDay() + 7) % 7;
  if (daysUntilWednesday === 0 && end.getUTCHours() >= 8) {
    end.setUTCDate(end.getUTCDate() + 7);
  } else {
    end.setUTCDate(end.getUTCDate() + daysUntilWednesday);
  }
  end.setUTCHours(8, 0, 0, 0);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 7);
  return { start: start.getTime(), end: end.getTime() };
}

async function loadSettings(): Promise<SettingsPayload> {
  const saved = readJSON(STORAGE_KEYS.settings, null);
  return { ...DEFAULT_SETTINGS, ...(saved || {}) };
}

async function saveSettings(data: Partial<SettingsPayload> | null | undefined): Promise<boolean> {
  writeJSON(STORAGE_KEYS.settings, { ...DEFAULT_SETTINGS, ...(data || {}) });
  return true;
}

async function getRosterList() {
  const list = ensureRosterList();
  let changed = false;

  const normalized = list.rosters.map((rosterMeta: RosterMeta) => {
    const payload = readJSON<RosterPayload>(STORAGE_KEYS.rosterData(rosterMeta.id), { roster: {}, order: [] });
    const nextCount = countRosterCharacters(payload?.roster);
    if (Number(rosterMeta.characterCount || 0) !== nextCount) {
      changed = true;
      return { ...rosterMeta, characterCount: nextCount };
    }
    return rosterMeta;
  });

  if (changed) {
    const nextList: RosterListState = {
      ...list,
      rosters: normalized,
    };
    setRosterList(nextList);
    return nextList.rosters;
  }

  return list.rosters;
}

async function getActiveRoster() {
  const activeRosterId = ensureRosterList().activeRosterId;
  return activeRosterId;
}

async function createRoster(name?: string): Promise<string> {
  const list = ensureRosterList();
  const id = generateId();
  const rosterMeta = { id, name: name?.trim() || 'Roster', createdAt: Date.now(), characterCount: 0 };
  list.rosters.push(rosterMeta);
  list.activeRosterId = id;
  setRosterList(list);
  // Initialize empty data buckets
  writeJSON(STORAGE_KEYS.rosterData(id), { roster: {}, order: [] });
  writeJSON(STORAGE_KEYS.characterData(id), {});
  return id;
}

async function deleteRoster(rosterId: string): Promise<boolean> {
  const list = ensureRosterList();
  list.rosters = list.rosters.filter((r: RosterMeta) => r.id !== rosterId);
  if (list.activeRosterId === rosterId) {
    list.activeRosterId = list.rosters[0]?.id || null;
  }
  setRosterList(list);
  writeJSON(STORAGE_KEYS.rosterData(rosterId), { roster: {}, order: [] });
  writeJSON(STORAGE_KEYS.characterData(rosterId), {});
  return true;
}

async function renameRoster(rosterId: string, newName: string): Promise<boolean> {
  const list = ensureRosterList();
  list.rosters = list.rosters.map((r: RosterMeta) => (r.id === rosterId ? { ...r, name: newName?.trim() || r.name } : r));
  setRosterList(list);
  return true;
}

async function switchActiveRoster(rosterId: string): Promise<string | null> {
  const list = ensureRosterList();
  if (list.rosters.find((r: RosterMeta) => r.id === rosterId)) {
    list.activeRosterId = rosterId;
    setRosterList(list);
  }
  return list.activeRosterId;
}

async function loadRoster(rosterId: string): Promise<RosterPayload> {
  const payload = readJSON(STORAGE_KEYS.rosterData(rosterId), { roster: {}, order: [] });
  return payload;
}

function countRosterCharacters(roster: Record<string, unknown> | null | undefined): number {
  if (!roster || typeof roster !== 'object') {
    return 0;
  }

  return Object.keys(roster).filter((name) => !ROSTER_META_KEYS.has(name)).length;
}

async function saveRoster(rosterId: string, data: RosterPayload | null | undefined): Promise<boolean> {
  const safe = data || { roster: {}, order: [] };
  writeJSON(STORAGE_KEYS.rosterData(rosterId), safe);
  // Update characterCount metadata
  const list = ensureRosterList();
  list.rosters = list.rosters.map((r: RosterMeta) => (r.id === rosterId ? { ...r, characterCount: countRosterCharacters(safe.roster) } : r));
  setRosterList(list);
  return true;
}

async function loadCharacterData(rosterId: string): Promise<Record<string, unknown>> {
  return readJSON(STORAGE_KEYS.characterData(rosterId), {});
}

async function saveCharacterData(rosterId: string, data: Record<string, unknown> | null | undefined): Promise<boolean> {
  writeJSON(STORAGE_KEYS.characterData(rosterId), data || {});
  return true;
}

async function loadParadiseData(rosterId: string) {
  return readJSON(STORAGE_KEYS.paradiseData(rosterId), { weekKey: '', data: {} });
}

async function saveParadiseData(
  rosterId: string,
  data: { weekKey: string; data: Record<string, { elysian: boolean; crucible: boolean; hell: boolean }> } | null | undefined,
): Promise<boolean> {
  writeJSON(STORAGE_KEYS.paradiseData(rosterId), data || { weekKey: '', data: {} });
  return true;
}

async function getWeeklyResetPeriod(): Promise<{ start: number; end: number }> {
  return getWeeklyResetPeriodValue();
}

async function getRaids(): Promise<unknown> {
  try {
    return await dbBridge.getRaids();
  } catch (err) {
    console.error('Failed to read raids from encounters.db', err);
    return [];
  }
}

async function checkDatabaseExists() {
  // Bridge is ready means a File snapshot is loaded and the worker is open
  if (dbBridge.isReady) return true;
  // Try to restore from persisted handle (gives the worker a File snapshot)
  await restorePersistedHandle();
  return dbBridge.isReady;
}

async function getDatabaseAccessSupport(): Promise<DbAccessSupport> {
  return detectDatabaseAccessSupport();
}

async function getDatabasePermissionStatus(): Promise<DbPermissionStatus> {
  await restorePersistedHandle();
  const handle = currentHandle;
  if (!handle?.queryPermission) {
    return { hasHandle: Boolean(handle), permission: 'unknown' };
  }
  try {
    const permission = await handle.queryPermission({ mode: 'read' });
    return { hasHandle: true, permission: permission || 'unknown' };
  } catch (err) {
    console.warn('Failed to query permission', err);
    return { hasHandle: Boolean(handle), permission: 'unknown' };
  }
}

async function browseDatabaseFile(): Promise<string | null> {
  // Prefer the modern file picker when available; fallback to hidden input
  const tryNativePicker = async () => {
    if (!window.showOpenFilePicker) return null;

    try {
      const [handle] = await window.showOpenFilePicker({
        multiple: false,
        types: [
          {
            description: 'SQLite Database',
            accept: { 'application/x-sqlite3': ['.db'], 'application/octet-stream': ['.db'] },
          },
        ],
        excludeAcceptAllOption: false,
      });

      const permission = await ensureHandlePermission(handle);
      if (!permission) return null;

      await persistHandle(handle);
      await loadDatabaseFromHandle(handle);
      return uploadedDbName;
    } catch {
      // User cancel or unsupported startIn; fall through to input picker
      return null;
    }
  };

  const pickerResult = await tryNativePicker();
  if (pickerResult) return pickerResult;

  return new Promise<string | null>((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.db';
    input.style.display = 'none';

    input.onchange = async (event) => {
      const target = event.target as HTMLInputElement | null;
      const file = target?.files?.[0];
      if (!file) {
        resolve(null);
        input.remove();
        return;
      }
      try {
        await loadDatabaseFromFile(file);
        resolve(uploadedDbName);
      } catch {
        resolve(null);
      }
      input.remove();
    };

    // Trigger the file picker
    document.body.appendChild(input);
    input.click();

    // Clean up DOM node if user cancels (blur without change)
    input.addEventListener('blur', () => {
      setTimeout(() => input.remove(), 0);
    });
  });
}

async function ensureHandlePermission(handle: FileSystemFileHandleLike | null): Promise<boolean> {
  try {
    if (!handle?.requestPermission) return true;
    const current = await handle.queryPermission?.({ mode: 'read' });
    if (current === 'granted') return true;
    const result = await handle.requestPermission({ mode: 'read' });
    return result === 'granted';
  } catch (err) {
    console.warn('Permission request failed', err);
    return false;
  }
}

async function openHandleDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(HANDLE_DB, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(HANDLE_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function waitForTransaction(tx: IDBTransaction): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

async function persistHandle(handle: FileSystemFileHandleLike) {
  try {
    const db = await openHandleDb();
    const tx = db.transaction(HANDLE_STORE, 'readwrite');
    tx.objectStore(HANDLE_STORE).put(handle, HANDLE_KEY);
    await waitForTransaction(tx);
    db.close();
  } catch (err) {
    console.warn('Failed to persist handle', err);
  }
}

async function clearPersistedHandle() {
  try {
    const db = await openHandleDb();
    const tx = db.transaction(HANDLE_STORE, 'readwrite');
    tx.objectStore(HANDLE_STORE).delete(HANDLE_KEY);
    await waitForTransaction(tx);
    db.close();
  } catch (err) {
    console.warn('Failed to clear persisted handle', err);
  }
}

async function loadPersistedHandle(): Promise<FileSystemFileHandleLike | null> {
  try {
    const db = await openHandleDb();
    const tx = db.transaction(HANDLE_STORE, 'readonly');
    const req = tx.objectStore(HANDLE_STORE).get(HANDLE_KEY);
    const handle = await new Promise<FileSystemFileHandleLike | null>((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return handle || null;
  } catch {
    return null;
  }
}

async function restorePersistedHandle() {
  if (restoreHandlePromise) return restoreHandlePromise;
  restoreHandlePromise = (async () => {
    const handle = await loadPersistedHandle();
    if (!handle) return false;
    // On startup: ONLY check permission, never request it.
    // requestPermission() requires a user gesture; calling it automatically
    // shows the native browser popup on every page load, which is disruptive.
    // If permission is not already granted, store the handle so the UI can
    // show a "Reconnect database" button and the user can re-authorize manually.
    currentHandle = handle; // always store so getDatabasePermissionStatus works
    const current = await handle.queryPermission?.({ mode: 'read' }).catch(() => 'unknown');
    if (current !== 'granted') return false;
    try {
      const file = await handle.getFile?.();
      if (!file) return false;
      const changeCounter = await readSqliteChangeCounter(file);
      currentFile = file;
      updateDbMeta(file.name || 'encounters.db', { size: file.size, mtime: file.lastModified, changeCounter, name: file.name });
      // Init is lazy: the worker receives the File and opens the db on first init().
      await dbBridge.init(file);
      return true;
    } catch (err) {
      console.warn('Failed to open database from persisted handle', err);
      return false;
    }
  })();
  return restoreHandlePromise;
}

async function clearCurrentDatabase() {
  await clearPersistedHandle();
  currentHandle = null;
  currentFile = null;
  restoreHandlePromise = null;
  uploadedDbName = '';
  dbMeta = { size: null, mtime: null, changeCounter: null, name: '' };
  await dbBridge.close();
  return true;
}

/**
 * Request (or re-request) file access permission for the persisted handle.
 * MUST be called from a user gesture (e.g. a button click).
 * Returns { ok: true } on success or { ok: false, reason } on failure.
 */
async function requestDatabasePermission(): Promise<DbPermissionRequestResult> {
  const support = detectDatabaseAccessSupport();
  if (!support.persistentHandle) return { ok: false, reason: 'unsupported-browser' };
  const handle = currentHandle || await loadPersistedHandle();
  if (!handle) return { ok: false, reason: 'no-handle' };
  try {
    const result = await handle.requestPermission?.({ mode: 'read' });
    if (result !== 'granted') return { ok: false, reason: 'permission-denied' };
    currentHandle = handle;
    // Reset startup cache so subsequent restorePersistedHandle() calls work cleanly
    restoreHandlePromise = null;
    const file = await handle.getFile?.();
    if (!file) return { ok: false, reason: 'error' };
    const changeCounter = await readSqliteChangeCounter(file);
    currentFile = file;
    updateDbMeta(file.name || 'encounters.db', { size: file.size, mtime: file.lastModified, changeCounter, name: file.name });
    await dbBridge.reinit(file);
    return { ok: true };
  } catch (err) {
    console.warn('requestDatabasePermission failed', err);
    return { ok: false, reason: 'error' };
  }
}

async function reloadCurrentDatabase(): Promise<ReloadDbResult> {
  await restorePersistedHandle();

  if (currentHandle) {
    const permitted = await ensureHandlePermission(currentHandle);
    if (!permitted) return { ok: false, reason: 'permission-denied' };
    await refreshDatabaseFromHandleIfChanged();
    return { ok: true, loadedFile: uploadedDbName, source: 'handle' };
  }

  if (currentFile && dbBridge.isReady) {
    // File-only drop (no persistent handle) — bridge already has the snapshot
    return { ok: true, loadedFile: uploadedDbName, source: 'file' };
  }

  return { ok: false, reason: 'no-database' };
}

async function resetAppData() {
  await clearCurrentDatabase();

  try {
    const keysToRemove = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key?.startsWith('wtl:')) {
        keysToRemove.push(key);
      }
    }
    keysToRemove.forEach((key) => localStorage.removeItem(key));
  } catch (err) {
    console.warn('Failed to clear localStorage app keys', err);
  }

  inMemory.clear();
  return true;
}

async function loadDatabaseFromHandle(handle: FileSystemFileHandleLike): Promise<void> {
  const permitted = await ensureHandlePermission(handle);
  if (!permitted) return;
  await persistHandle(handle);
  currentHandle = handle;
  const file = await handle.getFile?.();
  if (!file) return;
  const changeCounter = await readSqliteChangeCounter(file);
  currentFile = file;
  updateDbMeta(file.name || 'encounters.db', { size: file.size, mtime: file.lastModified, changeCounter, name: file.name });
  // reinit: close old worker (if any) and open fresh with new File snapshot
  await dbBridge.reinit(file);
}

async function loadDatabaseFromFile(file: File): Promise<void> {
  const changeCounter = await readSqliteChangeCounter(file);
  currentFile = file;
  updateDbMeta(file.name || 'encounters.db', { size: file.size, mtime: file.lastModified, changeCounter, name: file.name });
  await dbBridge.reinit(file);
}

async function refreshDatabaseFromHandleIfChanged() {
  if (!currentHandle) return false;
  try {
    const file = await currentHandle.getFile?.();
    if (!file) return false;
    // Primary: compare SQLite file change counter (bytes 24-27, incremented on every COMMIT)
    const fileCounter = await readSqliteChangeCounter(file);
    const counterKnown = fileCounter !== null && dbMeta.changeCounter !== null;
    if (counterKnown && fileCounter === dbMeta.changeCounter) return false;
    // Fallback: size + mtime when header is unreadable
    if (!counterKnown && dbMeta.size === file.size && dbMeta.mtime === file.lastModified) return false;
    // File changed — give worker a fresh snapshot (no copy, near-instant)
    currentFile = file;
    updateDbMeta(file.name || 'encounters.db', { size: file.size, mtime: file.lastModified, changeCounter: fileCounter, name: file.name });
    await dbBridge.reinit(file);
    return true;
  } catch (err) {
    console.warn('Failed to refresh database from handle', err);
    return false;
  }
}

async function getDailyGuardianRaids(characterName: string): Promise<false | DailyCompletion> {
  if (!characterName) return false;
  try {
    return await dbBridge.getDailyGuardianRaids(characterName) as false | DailyCompletion;
  } catch (err) {
    console.error('Failed to read guardian raids from encounters.db', err);
    return false;
  }
}

async function getDailyFieldBoss(rosterNames: string[] = []): Promise<false | DailyCompletion> {
  if (!Array.isArray(rosterNames) || rosterNames.length === 0) return false;
  try {
    return await dbBridge.getDailyFieldBoss(rosterNames) as false | DailyCompletion;
  } catch (err) {
    console.error('Failed to read field boss from encounters.db', err);
    return false;
  }
}

async function getDailyChaosGate(rosterNames: string[] = []): Promise<false | DailyCompletion> {
  if (!Array.isArray(rosterNames) || rosterNames.length === 0) return false;
  try {
    return await dbBridge.getDailyChaosGate(rosterNames) as false | DailyCompletion;
  } catch (err) {
    console.error('Failed to read chaos gate from encounters.db', err);
    return false;
  }
}

async function getWeeklyThaemine(rosterNames: string[] = []): Promise<false | DailyCompletion> {
  if (!Array.isArray(rosterNames) || rosterNames.length === 0) return false;
  try {
    return await dbBridge.getWeeklyThaemine(rosterNames) as false | DailyCompletion;
  } catch (err) {
    console.error('Failed to read Thaemine from encounters.db', err);
    return false;
  }
}

async function fetchCharacterByName() {
  return null;
}

async function fetchRosterByGuid() {
  return null;
}


// Logging no-ops
async function logDebug() { return true; }
async function logInfo() { return true; }
async function logWarn() { return true; }
async function logError() { return true; }
async function logException() { return true; }
async function getRecentLogs() { return []; }

// Expose the web shim
const api: AppApi = {
  loadSettings,
  saveSettings,
  getRaids,
  getWeeklyResetPeriod,
  getDailyGuardianRaids,
  getDailyFieldBoss,
  getDailyChaosGate,
  getWeeklyThaemine,
  getRosterList,
  getActiveRoster,
  createRoster,
  deleteRoster,
  renameRoster,
  switchActiveRoster,
  loadRoster,
  saveRoster,
  loadCharacterData,
  saveCharacterData,
  loadParadiseData,
  saveParadiseData,
  browseDatabaseFile,
  checkDatabaseExists,
  getDatabaseAccessSupport,
  getDatabasePermissionStatus,
  requestDatabasePermission,
  restorePersistedHandle,
  importDatabaseHandle: loadDatabaseFromHandle,
  importDatabaseFile: loadDatabaseFromFile,
  reloadCurrentDatabase,
  clearCurrentDatabase,
  resetAppData,
  fetchCharacterByName,
  fetchRosterByGuid,
  logDebug,
  logInfo,
  logWarn,
  logError,
  logException,
  getRecentLogs,
};

if (typeof window !== 'undefined') {
  window.api = api;
  window.__API_READY__ = Promise.resolve();
}

export default api;