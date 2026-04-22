import type { AppApi, RosterMeta, SettingsPayload } from '../../types/app-api';

const api: AppApi = window.api;

export const DEFAULT_SETTINGS: SettingsPayload = {
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

export type RosterSwitcherState = {
  rosters: RosterMeta[];
  activeRosterId: string;
  settings: SettingsPayload;
};

export class RosterService {
  static async loadRosterSwitcherState(): Promise<RosterSwitcherState> {
    const [list, active, loadedSettings] = await Promise.all([
      api.getRosterList(),
      api.getActiveRoster(),
      api.loadSettings(),
    ]);

    const rosters = Array.isArray(list) ? list : [];
    let activeRosterId = String(active || rosters[0]?.id || '');

    if (!activeRosterId && rosters.length > 0) {
      activeRosterId = rosters[0].id;
      await api.switchActiveRoster(activeRosterId);
    }

    return {
      rosters,
      activeRosterId,
      settings: {
        ...DEFAULT_SETTINGS,
        ...(loadedSettings || {}),
      } as SettingsPayload,
    };
  }

  static async getActiveRosterId(): Promise<string> {
    return String((await api.getActiveRoster()) || '').trim();
  }

  static async switchActiveRoster(rosterId: string): Promise<string | null> {
    return await api.switchActiveRoster(rosterId);
  }

  static async createRoster(name: string): Promise<string> {
    return await api.createRoster(name);
  }

  static async renameRoster(rosterId: string, nextName: string): Promise<boolean> {
    return await api.renameRoster(rosterId, nextName);
  }

  static async deleteRoster(rosterId: string): Promise<boolean> {
    return await api.deleteRoster(rosterId);
  }

  static async saveSettings(nextSettings: SettingsPayload): Promise<boolean> {
    return await api.saveSettings(nextSettings);
  }
}
