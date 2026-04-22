<script lang="ts">
  import SettingsGeneralSection from './SettingsGeneralSection.svelte';
  import SettingsRostersSection from './SettingsRostersSection.svelte';
  import SettingsTrackerSection from './SettingsTrackerSection.svelte';
  import SettingsDatabaseSection from './SettingsDatabaseSection.svelte';
  import SettingsAboutSection from './SettingsAboutSection.svelte';

  type SettingsSection = 'general' | 'rosters' | 'tracker' | 'database' | 'about';

  export let section: SettingsSection = 'general';
  export let onSelectSection: (next: SettingsSection) => void = () => undefined;

  const NAV: Array<{ id: SettingsSection; label: string }> = [
    { id: 'general', label: 'General' },
    { id: 'rosters', label: 'Rosters' },
    { id: 'tracker', label: 'Tracker Integration' },
    { id: 'database', label: 'Database Import' },
  ];
</script>

<section class="tab-content active settings-layout" id="settings-tab" aria-live="polite">
  <aside class="settings-sidebar" aria-label="Settings navigation">
    <nav>
      <ul>
        {#each NAV as item (item.id)}
          <li>
            <button
              type="button"
              class="settings-sidebar__item"
              class:active={section === item.id}
              on:click={() => onSelectSection(item.id)}
            >
              {item.label}
            </button>
          </li>
        {/each}
      </ul>
    </nav>
  </aside>

  <div class="settings-main">
    {#if section === 'general'}
      <SettingsGeneralSection />
    {:else if section === 'rosters'}
      <SettingsRostersSection />
    {:else if section === 'tracker'}
      <SettingsTrackerSection />
    {:else if section === 'database'}
      <SettingsDatabaseSection />
    {:else if section === 'about'}
      <SettingsAboutSection />
    {/if}
  </div>
</section>

