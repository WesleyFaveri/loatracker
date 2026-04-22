<script lang="ts">
  import WizardPage from '../wizard/WizardPage.svelte';
  import SettingsHeader from './SettingsHeader.svelte';

  function navigateToRosters() {
    window.location.hash = 'settings/rosters';
  }
</script>

<SettingsHeader title="Tracker Integration" hint="Import your roster using the Bible API or add characters manually." />

<div class="tracker-wizard-wrap">
  <WizardPage onRequestClose={() => undefined} onNavigateToRoster={navigateToRosters} />
</div>

<style>
  .tracker-wizard-wrap {
    background: color-mix(in srgb, var(--color-surface-light) 92%, var(--color-surface));
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    padding: var(--spacing-lg);
    margin-bottom: var(--spacing-lg);
  }

  .tracker-wizard-wrap :global(.close-btn) {
    display: none;
  }
</style>
