import { WEEKLY_RESET } from '../../legacy/config/constants.js';
import type { ParadiseCharacterEntry, ParadiseData, ParadiseRaidKey } from '../../../types/app-api';

export const PARADISE_RAID_KEYS: readonly ParadiseRaidKey[] = ['elysian', 'crucible', 'hell'] as const;

export const PARADISE_RAID_LABELS: Record<ParadiseRaidKey, string> = {
  elysian: 'Elysian',
  crucible: 'Crucible',
  hell: 'Hell',
};

export function emptyParadiseEntry(): ParadiseCharacterEntry {
  return { elysian: false, crucible: false, hell: false };
}

export function normalizeParadiseEntry(value: unknown): ParadiseCharacterEntry {
  if (!value || typeof value !== 'object') return emptyParadiseEntry();
  const record = value as Record<string, unknown>;
  return {
    elysian: record.elysian === true,
    crucible: record.crucible === true,
    hell: record.hell === true,
  };
}

export function getParadiseWeekStartUtc(now: Date = new Date()): Date {
  const result = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    WEEKLY_RESET.HOUR_UTC,
    0,
    0,
    0,
  ));

  const dayDiff = (result.getUTCDay() - WEEKLY_RESET.DAY_OF_WEEK + 7) % 7;
  result.setUTCDate(result.getUTCDate() - dayDiff);

  if (now.getTime() < result.getTime()) {
    result.setUTCDate(result.getUTCDate() - 7);
  }

  return result;
}

export function getParadiseWeekKey(now: Date = new Date()): string {
  const start = getParadiseWeekStartUtc(now);
  const year = start.getUTCFullYear();
  const month = String(start.getUTCMonth() + 1).padStart(2, '0');
  const day = String(start.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function normalizeParadiseData(value: unknown): ParadiseData {
  if (!value || typeof value !== 'object') return { weekKey: '', data: {} };
  const record = value as Record<string, unknown>;
  const weekKey = typeof record.weekKey === 'string' ? record.weekKey : '';
  const raw = record.data && typeof record.data === 'object' ? record.data as Record<string, unknown> : {};
  const data: Record<string, ParadiseCharacterEntry> = {};
  for (const [name, entry] of Object.entries(raw)) {
    data[name] = normalizeParadiseEntry(entry);
  }
  return { weekKey, data };
}

/**
 * Drop the checkboxes when stored weekKey is stale; keep only known characters.
 * Returns `{ data, changed }` where `changed` signals the caller to persist.
 */
export function applyWeeklyResetIfNeeded(
  stored: ParadiseData,
  characterNames: string[],
  now: Date = new Date(),
): { data: ParadiseData; changed: boolean } {
  const currentKey = getParadiseWeekKey(now);
  if (stored.weekKey === currentKey) {
    const nameSet = new Set(characterNames);
    const pruned: Record<string, ParadiseCharacterEntry> = {};
    let changed = false;
    for (const [name, entry] of Object.entries(stored.data)) {
      if (nameSet.has(name)) {
        pruned[name] = entry;
      } else {
        changed = true;
      }
    }
    return { data: { weekKey: currentKey, data: pruned }, changed };
  }

  return { data: { weekKey: currentKey, data: {} }, changed: true };
}

export function setParadiseCheckbox(
  data: ParadiseData,
  name: string,
  key: ParadiseRaidKey,
  value: boolean,
): ParadiseData {
  const existing = normalizeParadiseEntry(data.data[name]);
  return {
    weekKey: data.weekKey,
    data: {
      ...data.data,
      [name]: { ...existing, [key]: value },
    },
  };
}
