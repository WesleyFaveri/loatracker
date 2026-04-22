<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { withAsyncError } from '../utils/errorWrappers';
  import { ERROR_CODES } from '../utils/errorCodes';
  import type { RosterMeta } from '../../types/app-api';
  import { notifyRosterChanged, rosterChangeVersion } from '../stores/rosterSync';
  import { RosterService } from '../services/RosterService';

  let rosters: RosterMeta[] = [];
  let activeRosterId = '';
  let unsubscribeRosterChanges: (() => void) | null = null;

  $: sortedRosters = [...rosters].sort(
    (left, right) => Number(left.createdAt || 0) - Number(right.createdAt || 0),
  );

  onMount(async () => {
    await window.__API_READY__;
    await refresh();

    let isInitialRosterSync = true;
    unsubscribeRosterChanges = rosterChangeVersion.subscribe(() => {
      if (isInitialRosterSync) {
        isInitialRosterSync = false;
        return;
      }
      void refresh();
    });
  });

  onDestroy(() => {
    unsubscribeRosterChanges?.();
    unsubscribeRosterChanges = null;
  });

  async function refresh() {
    await withAsyncError(async () => {
      const snapshot = await RosterService.loadRosterSwitcherState();
      rosters = snapshot.rosters;
      activeRosterId = snapshot.activeRosterId;
      return true;
    }, {
      code: ERROR_CODES.ROSTER_SWITCHER.REFRESH_FAILED,
      severity: 'error',
      context: {
        phase: 'refresh',
        action: 'refresh-roster-switcher',
        rosterId: activeRosterId,
        activeRosterId,
        rosterCount: rosters.length,
      },
      showToast: true,
    });
  }

  async function switchRoster(event: Event) {
    const target = event.currentTarget as HTMLSelectElement;
    const nextRosterId = String(target.value || '').trim();
    if (!nextRosterId) {
      return;
    }

    const persistedActive = await RosterService.getActiveRosterId();
    if (nextRosterId === persistedActive) {
      activeRosterId = persistedActive;
      return;
    }

    await RosterService.switchActiveRoster(nextRosterId);
    activeRosterId = nextRosterId;
    await refresh();
    notifyRosterChanged();
  }
</script>

{#if sortedRosters.length > 1}
  <div id="roster-switcher-container">
    <div class="roster-switcher">
      <select
        id="roster-select"
        class="roster-select"
        aria-label="Select active roster"
        bind:value={activeRosterId}
        on:change={switchRoster}
      >
        {#each sortedRosters as roster (roster.id)}
          <option value={roster.id}>{roster.name}</option>
        {/each}
      </select>
    </div>
  </div>
{/if}
