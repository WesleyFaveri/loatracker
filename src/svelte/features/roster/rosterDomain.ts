import type { AppApi, CharacterImportRow, RosterCharacter, RosterPayload } from '../../../types/app-api';

export type SortType = 'manual' | 'ilvl' | 'combatPower';

const META_KEYS = new Set(['dailyData']);

export type RosterEntry = {
  name: string;
  data: RosterCharacter;
};

export const BIBLE_VALID_CLASSES: ReadonlySet<string> = new Set([
  'Slayer', 'Valkyrie', 'Berserker', 'Destroyer', 'Gunlancer', 'Paladin', 'Guardian Knight',
  'Glaivier', 'Scrapper', 'Soulfist', 'Wardancer', 'Breaker', 'Striker',
  'Gunslinger', 'Artillerist', 'Deadeye', 'Machinist', 'Sharpshooter',
  'Arcanist', 'Bard', 'Sorceress', 'Summoner',
  'Deathblade', 'Reaper', 'Shadowhunter', 'Souleater',
  'Aeromancer', 'Artist', 'Wildsoul',
]);

export const BIBLE_FALLBACK_CLASS = 'Berserker';
export const BIBLE_FALLBACK_ILVL = 1500;

/** Normalizes a class string coming from the Bible API. Unknown values
 * fall back to {@link BIBLE_FALLBACK_CLASS}. */
export function normalizeBibleClass(value: unknown): string {
  const safe = String(value ?? '').trim();
  if (BIBLE_VALID_CLASSES.has(safe)) return safe;
  return BIBLE_FALLBACK_CLASS;
}

export function normalizeBibleIlvl(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : BIBLE_FALLBACK_ILVL;
}

/** CP can arrive as a number, a `{ score }` object, or be missing. */
export function normalizeBibleCombatPower(value: unknown): number | null {
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const candidate = Number(record.score ?? record.value ?? 0);
    return Number.isFinite(candidate) && candidate > 0 ? candidate : null;
  }
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function isCharacterKey(name: string): boolean {
  return !META_KEYS.has(name);
}

export function normalizeCharacter(value: unknown): RosterCharacter {
  if (!value || typeof value !== 'object') {
    return {
      class: 'Unknown',
      ilvl: 0,
      visible: true,
      visibleInParadise: false,
      combatPower: null,
    };
  }

  const source = value as Record<string, unknown>;
  const candidate = source.data && typeof source.data === 'object'
    ? (source.data as Record<string, unknown>)
    : source;

  const normalizedClass = String(
    candidate.class ?? candidate.charClass ?? candidate.characterClass ?? ''
  ).trim() || 'Unknown';

  const normalizedIlvl = Number(
    candidate.ilvl ?? candidate.itemLevel ?? candidate.iLvl ?? 0
  );

  const normalizedCombatPower = Number(
    candidate.combatPower ?? candidate.cp ?? 0
  );

  return {
    class: normalizedClass,
    ilvl: Number.isFinite(normalizedIlvl) ? normalizedIlvl : 0,
    visible: candidate.visible !== false,
    visibleInParadise: candidate.visibleInParadise === true,
    combatPower: Number.isFinite(normalizedCombatPower) && normalizedCombatPower > 0 ? normalizedCombatPower : null,
  };
}

export function characterKeys(roster: Record<string, unknown>): string[] {
  return Object.keys(roster || {}).filter(isCharacterKey);
}

export function orderedEntries(roster: Record<string, unknown>, order: string[]): RosterEntry[] {
  const rosterKeys = characterKeys(roster)
    .map((name) => String(name || '').trim())
    .filter(Boolean);

  const normalizedOrder = (order || [])
    .map((name) => String(name || '').trim())
    .filter((name) => Boolean(name) && rosterKeys.includes(name));

  const missing = rosterKeys.filter((name) => !normalizedOrder.includes(name));
  const finalNames = [...normalizedOrder, ...missing];

  return finalNames.map((name) => ({
    name,
    data: normalizeCharacter(roster[name]),
  }));
}

export function applySort(entries: RosterEntry[], sortType: SortType): string[] {
  if (sortType === 'manual') {
    return entries.map((entry) => entry.name);
  }

  const sorted = [...entries].sort((left, right) => {
    if (sortType === 'ilvl') {
      if (left.data.ilvl === right.data.ilvl) return left.name.localeCompare(right.name);
      return right.data.ilvl - left.data.ilvl;
    }

    const leftCp = Number(left.data.combatPower || 0);
    const rightCp = Number(right.data.combatPower || 0);
    if (leftCp === rightCp) return left.name.localeCompare(right.name);
    return rightCp - leftCp;
  });

  return sorted.map((entry) => entry.name);
}

export function upsertCharacter(
  roster: Record<string, unknown>,
  order: string[],
  payload: {
    name: string;
    class: string;
    ilvl: number;
    combatPower: number | null;
    editingName?: string | null;
  }
): { roster: Record<string, unknown>; order: string[]; created: boolean } {
  const nextRoster = { ...roster };
  const nextOrder = [...order];

  const name = payload.name.trim();
  const editingName = String(payload.editingName || '').trim();

  if (!name) {
    throw new Error('Character name is required');
  }

  if (!payload.class.trim()) {
    throw new Error('Character class is required');
  }

  if (!Number.isFinite(payload.ilvl) || payload.ilvl <= 0) {
    throw new Error('Item level must be greater than zero');
  }

  if (editingName) {
    if (editingName !== name && nextRoster[name]) {
      throw new Error('Character already exists');
    }

    if (editingName !== name) {
      delete nextRoster[editingName];
      const index = nextOrder.indexOf(editingName);
      if (index >= 0) nextOrder[index] = name;
    }

    nextRoster[name] = {
      class: payload.class,
      ilvl: payload.ilvl,
      visible: true,
      combatPower: payload.combatPower,
    } satisfies RosterCharacter;

    return { roster: nextRoster, order: nextOrder, created: false };
  }

  if (nextRoster[name]) {
    throw new Error('Character already exists');
  }

  nextRoster[name] = {
    class: payload.class,
    ilvl: payload.ilvl,
    visible: true,
    combatPower: payload.combatPower,
  } satisfies RosterCharacter;

  nextOrder.push(name);
  return { roster: nextRoster, order: nextOrder, created: true };
}

export function removeCharacter(roster: Record<string, unknown>, order: string[], name: string) {
  const nextRoster = { ...roster };
  delete nextRoster[name];
  const nextOrder = order.filter((entry) => entry !== name);
  return { roster: nextRoster, order: nextOrder };
}

export function toggleCharacterVisibility(roster: Record<string, unknown>, name: string) {
  const current = normalizeCharacter(roster[name]);
  return {
    ...roster,
    [name]: {
      ...current,
      visible: !(current.visible !== false),
    },
  };
}

export function toggleCharacterParadiseVisibility(roster: Record<string, unknown>, name: string) {
  const current = normalizeCharacter(roster[name]);
  return {
    ...roster,
    [name]: {
      ...current,
      visibleInParadise: !current.visibleInParadise,
    },
  };
}

export function reorderNames(order: string[], draggedName: string, targetName: string): string[] {
  const nextOrder = [...order];
  const draggedIndex = nextOrder.indexOf(draggedName);
  const targetIndex = nextOrder.indexOf(targetName);

  if (draggedIndex < 0 || targetIndex < 0 || draggedName === targetName) {
    return nextOrder;
  }

  const temp = nextOrder[draggedIndex];
  nextOrder[draggedIndex] = nextOrder[targetIndex];
  nextOrder[targetIndex] = temp;
  return nextOrder;
}

export function applyRefreshToExisting(roster: Record<string, unknown>, apiRows: CharacterImportRow[]): { roster: Record<string, unknown>; updatedCount: number } {
  const nextRoster = { ...roster };
  let updatedCount = 0;

  for (const apiCharacter of apiRows) {
    const safeName = String(apiCharacter?.name || '').trim();
    if (!safeName || !nextRoster[safeName]) {
      continue;
    }

    const current = normalizeCharacter(nextRoster[safeName]);
    nextRoster[safeName] = {
      ...current,
      class: String(apiCharacter.class || current.class || '').trim() || current.class,
      ilvl: Number.isFinite(Number(apiCharacter.ilvl)) ? Number(apiCharacter.ilvl) : current.ilvl,
      combatPower: Number.isFinite(Number(apiCharacter.combatPower)) && Number(apiCharacter.combatPower) > 0
        ? Number(apiCharacter.combatPower)
        : current.combatPower ?? null,
    } satisfies RosterCharacter;

    updatedCount += 1;
  }

  return { roster: nextRoster, updatedCount };
}

export async function ensureActiveRosterId(api: AppApi, activeRosterId: string): Promise<string> {
  if (activeRosterId) {
    return activeRosterId;
  }

  const current = await api.getActiveRoster();
  if (current) {
    return current;
  }

  return api.createRoster('Main Roster');
}

export async function loadRosterState(api: AppApi, activeRosterId: string): Promise<{ activeRosterId: string; roster: Record<string, unknown>; order: string[] }> {
  const resolvedId = await ensureActiveRosterId(api, activeRosterId);
  if (!resolvedId) {
    throw new Error('No active roster selected');
  }

  const loaded = await api.loadRoster(resolvedId) as RosterPayload;
  const roster = loaded?.roster || {};
  const keys = characterKeys(roster);
  const loadedOrder = Array.isArray(loaded?.order) ? loaded.order.filter((name) => keys.includes(name)) : [];
  const missing = keys.filter((name) => !loadedOrder.includes(name));

  return {
    activeRosterId: resolvedId,
    roster,
    order: [...loadedOrder, ...missing],
  };
}

export async function persistRosterState(
  api: AppApi,
  activeRosterId: string,
  roster: Record<string, unknown>,
  order: string[]
): Promise<string> {
  const rosterId = await ensureActiveRosterId(api, activeRosterId);
  if (!rosterId) {
    throw new Error('No active roster selected');
  }

  await api.saveRoster(rosterId, { roster, order });
  return rosterId;
}
