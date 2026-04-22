import { BOSSES, RAID_CONFIG } from '../legacy/config/constants.js';
import type { AppApi, RosterPayload, SettingsPayload } from '../../types/app-api';
import { getHiddenRaidIdsForSettings, isCharacterEligibleForRaid } from '../domain/shared/raidDomain';

type InternalState = {
  activeRosterId: string;
  roster: Record<string, any>;
  rosterOrder: string[];
  characterData: Record<string, any>;
  settings: SettingsPayload & Record<string, any>;
};

type RosterSummary = {
  id: string;
  name?: string;
};

const DEFAULT_SETTINGS: SettingsPayload = {
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

export class FriendsStateService {
  private api: AppApi;
  private rosterSummaries: RosterSummary[] = [];
  private state: InternalState = {
    activeRosterId: '',
    roster: {},
    rosterOrder: [],
    characterData: {},
    settings: { ...DEFAULT_SETTINGS },
  };

  constructor(api: AppApi) {
    this.api = api;
  }

  async initialize() {
    const [loadedSettings, rosterList, activeRoster] = await Promise.all([
      this.api.loadSettings(),
      this.api.getRosterList(),
      this.api.getActiveRoster(),
    ]);

    this.state.settings = {
      ...DEFAULT_SETTINGS,
      ...(loadedSettings || {}),
    };

    this.rosterSummaries = (Array.isArray(rosterList) ? rosterList : []).map((roster) => ({
      id: String(roster?.id || '').trim(),
      name: String(roster?.name || '').trim() || 'Main Roster',
    })).filter((roster) => Boolean(roster.id));

    this.state.activeRosterId = String(activeRoster || this.rosterSummaries[0]?.id || '').trim();
    await this.loadRosterContext();
  }

  async reloadActiveRosterContext() {
    const [activeRoster, rosterList] = await Promise.all([
      this.api.getActiveRoster(),
      this.api.getRosterList(),
    ]);

    this.rosterSummaries = (Array.isArray(rosterList) ? rosterList : []).map((roster) => ({
      id: String(roster?.id || '').trim(),
      name: String(roster?.name || '').trim() || 'Main Roster',
    })).filter((roster) => Boolean(roster.id));

    this.state.activeRosterId = String(activeRoster || this.rosterSummaries[0]?.id || '').trim();
    await this.loadRosterContext();
  }

  private async loadRosterContext() {
    const rosterId = this.state.activeRosterId;
    if (!rosterId) {
      this.state.roster = {};
      this.state.rosterOrder = [];
      this.state.characterData = {};
      return;
    }

    const [loadedRoster, loadedCharacterData] = await Promise.all([
      this.api.loadRoster(rosterId),
      this.api.loadCharacterData(rosterId),
    ]);

    const payload = (loadedRoster || {}) as RosterPayload;
    const roster = (payload?.roster && typeof payload.roster === 'object') ? payload.roster : {};
    const order = Array.isArray(payload?.order) ? payload.order : [];

    this.state.roster = roster;
    this.state.rosterOrder = order;

    const safeCharacterData = (loadedCharacterData && typeof loadedCharacterData === 'object')
      ? loadedCharacterData
      : {};

    const validNames = new Set(Object.keys(roster || {}));
    const prunedCharacterData: Record<string, any> = {};
    Object.entries(safeCharacterData).forEach(([name, value]) => {
      if (validNames.has(name)) {
        prunedCharacterData[name] = value;
      }
    });

    this.state.characterData = prunedCharacterData;
  }

  get(path: string) {
    const keys = String(path || '').split('.').filter(Boolean);
    if (keys.length === 0) {
      return this.state;
    }

    let value: any = this.state;
    for (const key of keys) {
      if (value == null) {
        return undefined;
      }
      value = value[key];
    }
    return value;
  }

  setState(updates: Partial<InternalState>) {
    this.state = {
      ...this.state,
      ...updates,
      settings: {
        ...this.state.settings,
        ...(updates.settings || {}),
      },
      roster: {
        ...this.state.roster,
        ...(updates.roster || {}),
      },
      characterData: {
        ...this.state.characterData,
        ...(updates.characterData || {}),
      },
    };
  }

  getActiveRosterId() {
    return this.state.activeRosterId || null;
  }

  getRosters() {
    return [...this.rosterSummaries];
  }

  async saveSettings(settings?: SettingsPayload & Record<string, any>) {
    const nextSettings = {
      ...this.state.settings,
      ...(settings || {}),
    };
    this.state.settings = nextSettings;
    await this.api.saveSettings(nextSettings);
  }

  getHiddenRaidIds() {
    return getHiddenRaidIdsForSettings(this.state.settings, this.state.activeRosterId, RAID_CONFIG as Array<any>);
  }

  isCharacterEligible(ilvl: number, bossId: string) {
    return isCharacterEligibleForRaid(ilvl, bossId, RAID_CONFIG as Array<any>);
  }

  toStateAdapter() {
    return {
      get: (key: string) => this.get(key),
      getActiveRosterId: () => this.getActiveRosterId(),
      multiRosterManager: {
        getRosters: () => this.getRosters(),
      },
    };
  }

  toRosterManagerAdapter() {
    return {
      roster: this.state.roster,
      rosterOrder: this.state.rosterOrder,
    };
  }

  toWeeklyTrackerAdapter() {
    return {
      characterData: this.state.characterData,
      getBosses: () => [...(BOSSES as string[])],
      getHiddenRaidIds: () => this.getHiddenRaidIds(),
      isCharacterEligible: (ilvl: number, bossId: string) => this.isCharacterEligible(ilvl, bossId),
    };
  }
}
