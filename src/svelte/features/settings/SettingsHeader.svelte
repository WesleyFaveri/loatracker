<script lang="ts">
  export let title: string;
  export let hint: string = '';
</script>

<div class="settings-header settings-header--professional">
  <h1>{title}</h1>
  {#if hint}
    <p class="settings-compact-hint">{hint}</p>
  {/if}
</div>
