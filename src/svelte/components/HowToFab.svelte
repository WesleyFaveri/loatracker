<script lang="ts">
  export let onOpen: () => void;
</script>

<button
  type="button"
  class="howto-fab"
  aria-label="How to use"
  title="How to use"
  on:click={onOpen}
>
  <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
    <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2" />
    <path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.8.4-1 .9-1 1.7v.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
    <circle cx="12" cy="17" r="1" fill="currentColor" />
  </svg>
</button>

<style>
  .howto-fab {
    position: fixed;
    bottom: calc(var(--spacing-md) + env(safe-area-inset-bottom, 0px));
    left: var(--spacing-md);
    width: 44px;
    height: 44px;
    border-radius: var(--radius-full);
    background: var(--color-surface);
    color: var(--color-text);
    border: 1px solid var(--color-border);
    box-shadow: var(--shadow-md);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1800;
    transition: background var(--transition-fast), transform var(--transition-fast);
  }

  .howto-fab:hover {
    background: var(--color-surface-hover);
    transform: translateY(-1px);
  }

  .howto-fab:focus-visible {
    outline: none;
    box-shadow: 0 0 0 2px rgba(212, 175, 55, 0.45), var(--shadow-md);
  }
</style>
