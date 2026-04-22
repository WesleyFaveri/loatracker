export type PermissionResult = 'granted' | 'denied' | 'prompt' | 'unknown';

export type SettingsPayload = {
  dbPath: string;
  dbLastLoadedAt: number | null;
  timezone: string;
  dateFormat: string;
  timeFormat: string;
  autoRaidUpdateMinutes: number;
  autoRaidUpdateOnFocus: boolean;
  closeToTray: boolean;
  closeToTrayPrompted: boolean;
  hiddenColumns: string[];
  hiddenColumnsByRoster: Record<string, string[]>;
  hiddenBossColumns: string[];
  visibleWeeklyRosters: string[];
  visibleWeeklyRostersByRoster: Record<string, string[]>;
  paradiseBetaUnlocked: boolean;
  paradiseEnabled: boolean;
} & Record<string, unknown>;

export type RosterMeta = {
  id: string;
  name: string;
  createdAt: number;
  characterCount: number;
};

export type RosterCharacter = {
  class: string;
  ilvl: number;
  visible?: boolean;
  visibleInParadise?: boolean;
  combatPower?: number | null;
};

export type ParadiseRaidKey = 'elysian' | 'crucible' | 'hell';

export type ParadiseCharacterEntry = {
  elysian: boolean;
  crucible: boolean;
  hell: boolean;
};

export type ParadiseData = {
  weekKey: string;
  data: Record<string, ParadiseCharacterEntry>;
};

export type RosterPayload = {
  roster: Record<string, unknown>;
  order: string[];
};

export type CharacterImportRow = {
  name: string;
  class: string;
  ilvl: number;
  combatPower: number | null;
};

export type DbPermissionStatus = {
  hasHandle: boolean;
  permission: PermissionResult;
};

export type DbAccessSupport = {
  persistentHandle: boolean;
  nativeFilePicker: boolean;
  handleDragDrop: boolean;
  browser: 'firefox' | 'safari' | 'brave' | 'edge' | 'opera' | 'chrome' | 'chromium' | 'unknown';
};

export type DbPermissionRequestResult = {
  ok: boolean;
  reason?: 'no-handle' | 'permission-denied' | 'unsupported-browser' | 'error';
};

export type ReloadDbResult = {
  ok: boolean;
  reason?: 'permission-denied' | 'no-database' | 'error';
  loadedFile?: string;
  source?: 'handle' | 'file';
};

export interface AppApi {
  loadSettings(): Promise<SettingsPayload>;
  saveSettings(data: Partial<SettingsPayload> | null | undefined): Promise<boolean>;

  getRosterList(): Promise<RosterMeta[]>;
  getActiveRoster(): Promise<string | null>;
  createRoster(name?: string): Promise<string>;
  deleteRoster(rosterId: string): Promise<boolean>;
  renameRoster(rosterId: string, newName: string): Promise<boolean>;
  switchActiveRoster(rosterId: string): Promise<string | null>;

  loadRoster(rosterId: string): Promise<RosterPayload>;
  saveRoster(rosterId: string, data: RosterPayload | null | undefined): Promise<boolean>;

  loadCharacterData(rosterId: string): Promise<Record<string, unknown>>;
  saveCharacterData(rosterId: string, data: Record<string, unknown> | null | undefined): Promise<boolean>;

  loadParadiseData(rosterId: string): Promise<ParadiseData>;
  saveParadiseData(rosterId: string, data: ParadiseData | null | undefined): Promise<boolean>;

  getWeeklyResetPeriod(): Promise<{ start: number; end: number }>;
  getRaids(): Promise<unknown>;
  getDailyGuardianRaids(characterName: string): Promise<false | { completed: true; boss: string; timestamp: number }>;
  getDailyFieldBoss(rosterNames: string[]): Promise<false | { completed: true; boss: string; timestamp: number }>;
  getDailyChaosGate(rosterNames: string[]): Promise<false | { completed: true; boss: string; timestamp: number }>;
  getWeeklyThaemine(rosterNames: string[]): Promise<false | { completed: true; boss: string; timestamp: number }>;



  checkDatabaseExists(): Promise<boolean>;
  getDatabaseAccessSupport(): Promise<DbAccessSupport>;
  getDatabasePermissionStatus(): Promise<DbPermissionStatus>;
  requestDatabasePermission(): Promise<DbPermissionRequestResult>;
  restorePersistedHandle(): Promise<boolean>;
  importDatabaseHandle(handle: FileSystemFileHandle): Promise<void>;
  importDatabaseFile(file: File): Promise<void>;
  reloadCurrentDatabase(): Promise<ReloadDbResult>;
  clearCurrentDatabase(): Promise<boolean>;
  resetAppData(): Promise<boolean>;

  browseDatabaseFile(): Promise<string | null>;

  fetchCharacterByName(...args: unknown[]): Promise<unknown>;
  fetchRosterByGuid(...args: unknown[]): Promise<unknown>;

  logDebug(...args: unknown[]): Promise<boolean>;
  logInfo(...args: unknown[]): Promise<boolean>;
  logWarn(...args: unknown[]): Promise<boolean>;
  logError(...args: unknown[]): Promise<boolean>;
  logException(...args: unknown[]): Promise<boolean>;
  getRecentLogs(): Promise<unknown[]>;
}
