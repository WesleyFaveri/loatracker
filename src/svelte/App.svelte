<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { mountSupportDonateButton } from './legacy/components/SupportDonateButton.js';
  import type { AppApi, RosterPayload } from '../types/app-api';
  import { TOAST_TYPES } from './legacy/config/constants.js';
  import { UIHelper } from './utils/uiHelper';
  import { reportError } from './utils/errorHandler';
  import { ERROR_CODES } from './utils/errorCodes';
  import { runAutoRaidFocusUpdate } from './services/AutoRaidFocusUpdateService';
  import { FriendsStateService } from './services/FriendsStateService';
  import { FriendsRosterService } from './features/friends/services/FriendsRosterService';
  import { normalizeFriendsConfig } from './features/friends/config';
  import type { FriendsRosterConfig } from './features/friends/types';
  import RosterSwitcher from './components/RosterSwitcher.svelte';
  import HowToFab from './components/HowToFab.svelte';
  import { rosterChangeVersion } from './stores/rosterSync';

  const ROUTES = ['weekly', 'friends', 'custom', 'settings', 'howto'];
  const MAIN_ROUTES = ['weekly', 'friends', 'custom', 'settings'] as const;
  const MODAL_ROUTES = ['howto'] as const;
  const SETTINGS_SECTIONS = ['general', 'rosters', 'tracker', 'database', 'about'] as const;
  type AppRoute = (typeof ROUTES)[number];
  type ModalRoute = (typeof MODAL_ROUTES)[number];
  type MainRoute = (typeof MAIN_ROUTES)[number];
  type SettingsSection = (typeof SETTINGS_SECTIONS)[number];
  const api: AppApi = window.api;
  const ROSTER_META_KEYS = new Set(['dailyData']);
  const APP_FOCUS_AUTO_RAID_DEDUP_MS = 1200;
  const APP_FOCUS_AUTO_UPLOAD_DEDUP_MS = 1200;
  const MIN_FRIENDS_PIN_LENGTH = 4;
  let setupCheckInFlight = false;
  let appFocusAutoRaidInFlight = false;
  let appFocusAutoRaidLastRunAt = 0;
  let appFocusAutoUploadInFlight = false;
  let appFocusAutoUploadLastRunAt = 0;
  let inputAutocompleteObserver: MutationObserver | null = null;
  let lastSetupCheckedRosterId = '';
  let unsubscribeRosterChanges: (() => void) | null = null;
  let donateButton: { destroy?: () => void } | null = null;
  const ui = new UIHelper();

  function showToast(message: string, type = TOAST_TYPES.INFO) {
    ui.showToast(message, type);
  }

  function parseHash(input: string): { route: AppRoute; section: SettingsSection } {
    const value = input.replace(/^#\/?/, '').trim().toLowerCase();
    const [head, sub] = value.split('/');
    const route: AppRoute = (ROUTES as readonly string[]).includes(head) ? (head as AppRoute) : 'weekly';
    const section: SettingsSection = route === 'settings' && (SETTINGS_SECTIONS as readonly string[]).includes(sub)
      ? (sub as SettingsSection)
      : 'general';
    return { route, section };
  }

  function normalizeRoute(input: string): AppRoute {
    return parseHash(input).route;
  }

  /**
   * Back-compat redirect for bookmarks pointing at the removed top-level
   * `#roster` route. Collapses `#roster`, `#roster/`, and any sub-paths to
   * the new Rosters settings section. Returns true when a redirect was issued
   * so callers can short-circuit further processing.
   */
  function redirectLegacyRosterHash(): boolean {
    const value = window.location.hash.replace(/^#\/?/, '').trim().toLowerCase();
    const head = value.split('/')[0];
    if (head === 'roster') {
      window.location.hash = 'settings/rosters';
      return true;
    }
    return false;
  }

  redirectLegacyRosterHash();
  const initialParsed = parseHash(window.location.hash);
  let currentRoute: AppRoute = initialParsed.route;
  let settingsSection: SettingsSection = initialParsed.section;
  // Seed the background-route memory from the initial hash so that opening a
  // modal (e.g. #howto) immediately reflects the section the user loaded on,
  // not a hardcoded default.
  let previousMainRoute: MainRoute = isModalRoute(initialParsed.route)
    ? 'weekly'
    : asMainRoute(initialParsed.route);
  // Full raw hash of the last non-modal route (including any settings
  // subsection). Used to restore the exact location the user was on before
  // opening a modal like #howto, e.g. #settings/tracker → #howto → close
  // should land back on #settings/tracker rather than collapsing to #settings.
  let previousNonModalHash: string = isModalRoute(initialParsed.route)
    ? 'weekly'
    : window.location.hash.replace(/^#\/?/, '') || 'weekly';
  let modalFocusObserver: MutationObserver | null = null;
  let modalFocusRaf = 0;
  let lastTrackedModal: HTMLElement | null = null;
  let highlightSettingsButton = false;
  let weeklyPagePromise: Promise<any> | null = null;
  let friendsPagePromise: Promise<any> | null = null;
  let customPagePromise: Promise<any> | null = null;
  let settingsLayoutPromise: Promise<any> | null = null;
  let howToPagePromise: Promise<any> | null = null;

  function loadWeeklyPage() {
    weeklyPagePromise ??= import('./features/weekly/WeeklyPage.svelte');
    return weeklyPagePromise;
  }

  function loadFriendsPage() {
    friendsPagePromise ??= import('./features/friends/FriendsPage.svelte');
    return friendsPagePromise;
  }

  function loadCustomTabPage() {
    customPagePromise ??= import('./features/custom/CustomTabPage.svelte');
    return customPagePromise;
  }

  function loadSettingsLayout() {
    settingsLayoutPromise ??= import('./features/settings/SettingsLayout.svelte');
    return settingsLayoutPromise;
  }

  function loadHowToPage() {
    howToPagePromise ??= import('./features/howto/HowToPage.svelte');
    return howToPagePromise;
  }

  function isModalRoute(route: AppRoute): route is ModalRoute {
    return (MODAL_ROUTES as readonly string[]).includes(route);
  }

  function asMainRoute(route: AppRoute): MainRoute {
    if (route === 'friends' || route === 'custom' || route === 'settings') return route;
    return 'weekly';
  }

  $: activeMainRoute = isModalRoute(currentRoute) ? previousMainRoute : asMainRoute(currentRoute);

  function onHashChange() {
    if (redirectLegacyRosterHash()) {
      // The redirect triggers another hashchange that will run this handler
      // again with the rewritten value; skip processing the legacy hash.
      return;
    }
    const parsed = parseHash(window.location.hash);
    if (!isModalRoute(parsed.route)) {
      previousMainRoute = asMainRoute(parsed.route);
      previousNonModalHash = window.location.hash.replace(/^#\/?/, '') || 'weekly';
    }
    if (parsed.route === 'settings') {
      highlightSettingsButton = false;
    }
    if (parsed.route !== currentRoute) {
      currentRoute = parsed.route;
    }
    // Only sync settingsSection when we're actually on a settings route. When
    // a modal like #howto is opened on top of #settings/tracker, parseHash
    // returns section: 'general' (the fallback), which would otherwise flip
    // the underlying settings page behind the modal.
    if (parsed.route === 'settings' && parsed.section !== settingsSection) {
      settingsSection = parsed.section;
    }
  }

  function goTo(route: AppRoute | `settings/${SettingsSection}`) {
    const raw = String(route);
    const parsed = parseHash('#' + raw);
    if (!isModalRoute(parsed.route)) {
      previousMainRoute = asMainRoute(parsed.route);
      previousNonModalHash = raw;
    }
    if (parsed.route === 'settings') {
      highlightSettingsButton = false;
    }
    window.location.hash = raw;
  }

  function onHighlightSettingsCta() {
    highlightSettingsButton = true;
  }

  function closeModal() {
    window.location.hash = previousNonModalHash || previousMainRoute;
  }

  function onWindowKeyDown(event: KeyboardEvent) {
    if (event.key === 'Escape' && isModalRoute(currentRoute)) {
      closeModal();
      return;
    }

    if (!isArrowKey(event.key)) {
      return;
    }

    if (shouldIgnoreArrowNavigation(event)) {
      return;
    }

    const openModal = getOpenModalElement();
    const searchContext = (openModal?.querySelector('.modal-content') as HTMLElement | null) || openModal || document;
    const focusableElements = getFocusableElements(searchContext);

    if (!focusableElements.length) {
      return;
    }

    event.preventDefault();

    const activeElement = document.activeElement as HTMLElement | null;
    if (!activeElement || !focusableElements.includes(activeElement)) {
      focusElement(focusableElements[0]);
      return;
    }

    const next = findDirectionalElement(activeElement, focusableElements, event.key);
    if (next) {
      focusElement(next);
    }
  }

  function isArrowKey(key: string) {
    return key === 'ArrowRight' || key === 'ArrowLeft' || key === 'ArrowUp' || key === 'ArrowDown';
  }

  function shouldIgnoreArrowNavigation(event: KeyboardEvent) {
    const target = event.target as HTMLElement | null;
    if (!target) {
      return false;
    }

    const tagName = target.tagName;
    if (tagName === 'TEXTAREA' || tagName === 'SELECT') {
      return true;
    }

    if (tagName === 'INPUT') {
      const input = target as HTMLInputElement;
      const type = String(input.type || '').toLowerCase();
      return type !== 'checkbox' && type !== 'radio' && type !== 'button' && type !== 'submit';
    }

    return false;
  }

  function getOpenModalElement() {
    const modalCandidates = Array.from(document.querySelectorAll([
      '[role="alertdialog"]',
      '[role="dialog"][aria-modal="true"]',
      '.settings-confirm-overlay',
      '#friends-setup-modal',
      '#friends-heatmap-modal',
      '#column-settings-modal',
      '#custom-column-settings-modal',
      '#howto-modal',
      '#roster-manage-modal',
    ].join(', '))) as HTMLElement[];

    const visibleModals = modalCandidates.filter(isElementVisible);
    if (!visibleModals.length) {
      return null;
    }

    const ranked = visibleModals
      .map((element, index) => {
        const style = window.getComputedStyle(element);
        const zIndexRaw = style.zIndex;
        const zIndex = Number.parseInt(zIndexRaw, 10);
        return {
          element,
          index,
          zIndex: Number.isFinite(zIndex) ? zIndex : 0,
        };
      })
      .sort((left, right) => {
        if (left.zIndex !== right.zIndex) {
          return right.zIndex - left.zIndex;
        }

        return right.index - left.index;
      });

    return ranked[0]?.element || null;
  }

  function isElementVisible(element: HTMLElement) {
    if (!element || !document.body.contains(element)) {
      return false;
    }

    const style = window.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      return false;
    }

    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function getFocusableElements(context: HTMLElement | Document) {
    const selector = [
      'button:not([disabled])',
      'input:not([disabled]):not([type="checkbox"]):not([type="radio"])',
      'select:not([disabled])',
      'textarea:not([disabled])',
      '[href]',
      '.tab-button',
      '.character-card',
      '.remove-icon',
      '[tabindex]:not([tabindex="-1"])',
    ].join(',');

    const elements = Array.from(context.querySelectorAll(selector)) as HTMLElement[];
    return elements.filter((element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 10 && rect.height > 10;
    });
  }

  function findDirectionalElement(currentElement: HTMLElement, candidates: HTMLElement[], key: string) {
    const currentRect = currentElement.getBoundingClientRect();
    const currentCenter = {
      x: currentRect.left + (currentRect.width / 2),
      y: currentRect.top + (currentRect.height / 2),
    };

    let bestElement: HTMLElement | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;

    candidates.forEach((candidate) => {
      if (candidate === currentElement) {
        return;
      }

      const rect = candidate.getBoundingClientRect();
      const center = {
        x: rect.left + (rect.width / 2),
        y: rect.top + (rect.height / 2),
      };

      let isInDirection = false;
      let distance = 0;

      if (key === 'ArrowRight') {
        isInDirection = center.x > currentCenter.x + 5;
        distance = Math.abs(center.x - currentCenter.x) + (Math.abs(center.y - currentCenter.y) * 3);
      } else if (key === 'ArrowLeft') {
        isInDirection = center.x < currentCenter.x - 5;
        distance = Math.abs(center.x - currentCenter.x) + (Math.abs(center.y - currentCenter.y) * 3);
      } else if (key === 'ArrowDown') {
        isInDirection = center.y > currentCenter.y + 5;
        distance = Math.abs(center.y - currentCenter.y) + (Math.abs(center.x - currentCenter.x) * 3);
      } else if (key === 'ArrowUp') {
        isInDirection = center.y < currentCenter.y - 5;
        distance = Math.abs(center.y - currentCenter.y) + (Math.abs(center.x - currentCenter.x) * 3);
      }

      if (isInDirection && distance < bestDistance) {
        bestDistance = distance;
        bestElement = candidate;
      }
    });

    return bestElement;
  }

  function focusElement(element: HTMLElement | null | undefined) {
    if (!element) {
      return;
    }

    if (element.classList.contains('character-card') || element.classList.contains('remove-icon')) {
      element.setAttribute('tabindex', '0');
    }

    element.focus();
  }

  function getModalFocusRoot(modal: HTMLElement) {
    return (modal.querySelector('.modal-content, .settings-confirm-card, [role="document"]') as HTMLElement | null) || modal;
  }

  function getPrimaryModalFocusTarget(modal: HTMLElement) {
    const root = getModalFocusRoot(modal);
    const selectors = [
      '.danger-action-btn:not([disabled])',
      '[data-autofocus]:not([disabled])',
      '.settings-confirm-actions button:last-child:not([disabled])',
      '#confirm-yes:not([disabled])',
      'button[type="submit"]:not([disabled])',
      'button:not([disabled])',
      'input:not([disabled])',
      'select:not([disabled])',
      'textarea:not([disabled])',
      '[tabindex]:not([tabindex="-1"])',
    ];

    for (const selector of selectors) {
      const candidate = root.querySelector(selector) as HTMLElement | null;
      if (candidate && isElementVisible(candidate)) {
        return candidate;
      }
    }

    return null;
  }

  function ensureModalFocus(force = false) {
    const modal = getOpenModalElement();

    if (!modal) {
      lastTrackedModal = null;
      return;
    }

    const activeElement = document.activeElement as HTMLElement | null;
    const isInsideModal = Boolean(activeElement && modal.contains(activeElement));
    const isNewModal = modal !== lastTrackedModal;

    if (!force && isInsideModal && !isNewModal) {
      return;
    }

    const primaryTarget = getPrimaryModalFocusTarget(modal);
    if (primaryTarget) {
      focusElement(primaryTarget);
    } else {
      const root = getModalFocusRoot(modal);
      const focusables = getFocusableElements(root);
      if (focusables.length > 0) {
        focusElement(focusables[0]);
      } else {
        focusElement(modal);
      }
    }

    lastTrackedModal = modal;
  }

  function scheduleModalFocus(force = false) {
    if (modalFocusRaf) {
      cancelAnimationFrame(modalFocusRaf);
      modalFocusRaf = 0;
    }

    modalFocusRaf = requestAnimationFrame(() => {
      modalFocusRaf = 0;
      ensureModalFocus(force);
    });
  }

  function startModalFocusObserver() {
    if (modalFocusObserver) {
      modalFocusObserver.disconnect();
    }

    modalFocusObserver = new MutationObserver(() => {
      scheduleModalFocus(false);
    });

    modalFocusObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style', 'class', 'aria-hidden', 'open'],
    });

    scheduleModalFocus(true);
  }

  function onWindowCloseModalRequest() {
    if (isModalRoute(currentRoute)) {
      closeModal();
    }
  }

  function disableBrowserInputSuggestions(root: ParentNode = document) {
    const elements = Array.from(root.querySelectorAll('input, textarea')) as Array<HTMLInputElement | HTMLTextAreaElement>;
    elements.forEach((element) => {
      if ((element as HTMLElement).dataset.allowAutocomplete === 'true') {
        return;
      }

      if (element instanceof HTMLInputElement) {
        const type = String(element.type || '').toLowerCase();
        if (type === 'password') {
          element.setAttribute('autocomplete', 'new-password');
        } else {
          element.setAttribute('autocomplete', 'off');
        }
      } else {
        element.setAttribute('autocomplete', 'off');
      }

      element.setAttribute('autocorrect', 'off');
      element.setAttribute('autocapitalize', 'none');
      element.setAttribute('spellcheck', 'false');
    });
  }

  function startInputAutocompleteObserver() {
    if (inputAutocompleteObserver) {
      inputAutocompleteObserver.disconnect();
    }

    inputAutocompleteObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type !== 'childList') {
          continue;
        }

        mutation.addedNodes.forEach((node) => {
          if (!(node instanceof HTMLElement)) {
            return;
          }

          if (node.matches('input, textarea')) {
            disableBrowserInputSuggestions(node.parentElement || document);
            return;
          }

          disableBrowserInputSuggestions(node);
        });
      }
    });

    inputAutocompleteObserver.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  function isRosterPayloadEmpty(payload: RosterPayload | null | undefined) {
    const rosterData = payload?.roster;
    if (!rosterData || typeof rosterData !== 'object') {
      return true;
    }

    const characterKeys = Object.keys(rosterData).filter((key) => !ROSTER_META_KEYS.has(key));
    return characterKeys.length === 0;
  }

  async function shouldOpenSetupAssistant(activeRosterIdInput?: string | null) {
    await window.__API_READY__;
    const activeRosterId = String(activeRosterIdInput ?? await api.getActiveRoster() ?? '').trim();
    if (!activeRosterId) {
      return true;
    }

    const payload = await api.loadRoster(activeRosterId);
    return isRosterPayloadEmpty(payload);
  }

  async function runFirstTimeSetupCheck(force = false) {
    if (setupCheckInFlight) {
      return;
    }

    try {
      const activeRosterId = String(await api.getActiveRoster() || '').trim();
      if (!force && activeRosterId && activeRosterId === lastSetupCheckedRosterId) {
        return;
      }

      setupCheckInFlight = true;
      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, 500);
      });

      const shouldOpenWizard = await shouldOpenSetupAssistant(activeRosterId);
      lastSetupCheckedRosterId = activeRosterId;
      // Only redirect first-time users when they are NOT already in Settings.
      // Any Settings subsection (Rosters/Tracker/Database) is a valid place to
      // onboard from — forcing a jump to settings/tracker on top of an
      // intentional navigation (e.g. user opened Roster Management) feels like
      // a bug.
      if (shouldOpenWizard && currentRoute !== 'settings') {
        window.location.hash = 'settings/tracker';
      }
    } catch (error) {
      void reportError(error, {
        code: ERROR_CODES.STATE.LOAD_FAILED,
        severity: 'warning',
        context: {
          phase: 'runFirstTimeSetupCheck',
          action: 'check-first-time-user',
        },
        showToast: false,
      });
    } finally {
      setupCheckInFlight = false;
    }
  }

  function resolveSelfPinForRoster(config: FriendsRosterConfig, rosterId: string) {
    const safeRosterId = String(rosterId || '').trim();
    if (!safeRosterId) return '';

    const ownFriendEntry = (config.friends || []).find((friend) => String(friend?.rosterCode || '').trim() === safeRosterId);
    if (ownFriendEntry?.pin) {
      return String(ownFriendEntry.pin || '').trim();
    }

    const byRoster = config.selfPinsByRoster || {};
    return String(byRoster[safeRosterId] || '').trim();
  }

  async function tryAutoRaidUpdateOnAppFocus(settingsNow: Record<string, unknown>) {
    if (appFocusAutoRaidInFlight) {
      return;
    }

    const now = Date.now();
    if ((now - appFocusAutoRaidLastRunAt) < APP_FOCUS_AUTO_RAID_DEDUP_MS) {
      return;
    }

    appFocusAutoRaidInFlight = true;
    appFocusAutoRaidLastRunAt = now;

    try {
      await runAutoRaidFocusUpdate(api, settingsNow);
    } catch (error) {
      void api.logDebug?.('friends:auto-raid-focus-update-failed', {
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      appFocusAutoRaidInFlight = false;
    }
  }

  async function tryAutoUploadOnAppFocus() {
    if (appFocusAutoUploadInFlight) {
      return;
    }

    const now = Date.now();
    if ((now - appFocusAutoUploadLastRunAt) < APP_FOCUS_AUTO_UPLOAD_DEDUP_MS) {
      return;
    }

    appFocusAutoUploadInFlight = true;
    appFocusAutoUploadLastRunAt = now;

    try {
      const loadedSettings = (await api.loadSettings?.()) as Record<string, unknown> | null;
      const settingsNow = (loadedSettings || {}) as Record<string, unknown>;
      const friendsConfig = normalizeFriendsConfig(settingsNow.friendsRoster);

      await tryAutoRaidUpdateOnAppFocus(settingsNow);

      const friendsState = new FriendsStateService(api);
      await friendsState.initialize();

      const friendsService = new FriendsRosterService(
        friendsState.toWeeklyTrackerAdapter(),
        friendsState.toRosterManagerAdapter(),
        friendsState.toStateAdapter(),
      );

      if (!friendsService.isConfigured()) {
        return;
      }

      const activeRosterCode = String(friendsService.getSelfRosterCode() || '').trim();
      if (!activeRosterCode) {
        return;
      }

      const pin = resolveSelfPinForRoster(friendsConfig, activeRosterCode);
      if (pin.length < MIN_FRIENDS_PIN_LENGTH) {
        void api.logDebug?.('friends:auto-upload-focus-skip-pin-missing', {
          activeRosterCode,
          pinLength: pin.length,
        });
        return;
      }

      const snapshot = friendsService.buildSelfSnapshot();
      const pinHash = await friendsService.hashPin(pin);
      const fingerprint = friendsService.buildSyncFingerprint(snapshot, pinHash);
      const lastFingerprint = friendsConfig.lastUploadFingerprintByRoster?.[activeRosterCode];

      if (lastFingerprint && lastFingerprint === fingerprint) {
        void api.logDebug?.('friends:auto-upload-focus-skip-no-changes', { activeRosterCode });
        return;
      }

      const result = await friendsService.uploadSelfWeekly(pin);

      const nextSettings = {
        ...settingsNow,
        friendsRoster: {
          ...friendsConfig,
          lastUploadFingerprintByRoster: {
            ...(friendsConfig.lastUploadFingerprintByRoster || {}),
            [activeRosterCode]: result.fingerprint,
          },
        },
      };

      await api.saveSettings?.(nextSettings as any);

      if (result.skipped) {
        void api.logDebug?.('friends:auto-upload-focus-skip-server', {
          activeRosterCode,
          uploaded: result.uploaded,
        });
      } else {
        showToast(`Focus upload completed (${result.uploaded} characters).`, TOAST_TYPES.SUCCESS);
      }
    } catch (error) {
      void reportError(error, {
        code: ERROR_CODES.FRIENDS.AUTO_UPLOAD_FAILED,
        severity: 'warning',
        context: {
          phase: 'tryAutoUploadOnAppFocus',
          action: 'auto-upload-on-app-focus',
          route: currentRoute,
          activeMainRoute,
        },
        showToast: false,
      });
      void api.logDebug?.('friends:auto-upload-focus-failed', {
        route: currentRoute,
        activeMainRoute,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      appFocusAutoUploadInFlight = false;
    }
  }

  async function onAppVisibilityChange() {
    if (document.visibilityState !== 'visible') {
      return;
    }

    if (activeMainRoute === 'weekly') {
      return;
    }

    await tryAutoUploadOnAppFocus();
  }

  onMount(() => {
    donateButton = mountSupportDonateButton();
    window.addEventListener('wtl-close-modal', onWindowCloseModalRequest as EventListener);
    document.addEventListener('visibilitychange', onAppVisibilityChange);
    document.addEventListener('wtl-highlight-settings-cta', onHighlightSettingsCta as EventListener);
    disableBrowserInputSuggestions();
    startInputAutocompleteObserver();
    startModalFocusObserver();
    void runFirstTimeSetupCheck();

    let isInitialRosterSync = true;
    unsubscribeRosterChanges = rosterChangeVersion.subscribe(() => {
      if (isInitialRosterSync) {
        isInitialRosterSync = false;
        return;
      }

      void runFirstTimeSetupCheck(true);
    });
  });

  onDestroy(() => {
    donateButton?.destroy?.();
    donateButton = null;
    window.removeEventListener('wtl-close-modal', onWindowCloseModalRequest as EventListener);
    document.removeEventListener('visibilitychange', onAppVisibilityChange);
    document.removeEventListener('wtl-highlight-settings-cta', onHighlightSettingsCta as EventListener);

    if (modalFocusObserver) {
      modalFocusObserver.disconnect();
      modalFocusObserver = null;
    }

    if (modalFocusRaf) {
      cancelAnimationFrame(modalFocusRaf);
      modalFocusRaf = 0;
    }

    if (inputAutocompleteObserver) {
      inputAutocompleteObserver.disconnect();
      inputAutocompleteObserver = null;
    }

    unsubscribeRosterChanges?.();
    unsubscribeRosterChanges = null;
  });

  function onOverlayKeyDown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeModal();
      return;
    }

    if ((event.key === 'Enter' || event.key === ' ') && event.target === event.currentTarget) {
      event.preventDefault();
      closeModal();
    }
  }

  function getTabButtonId(route: MainRoute) {
    return `tab-${route}`;
  }

  function onOverlayClick(event: MouseEvent) {
    if (event.target === event.currentTarget) {
      closeModal();
    }
  }
</script>

<svelte:window on:hashchange={onHashChange} on:keydown={onWindowKeyDown} />

<main id="main-content">
  <header class="header">
    <div class="tabs" role="tablist" aria-label="Application sections">
    {#each ['weekly', 'friends', 'custom'] as const as route (route)}
      <button
        id={getTabButtonId(route)}
        class="tab-button"
        class:icon-tab={route === 'custom'}
        class:active={activeMainRoute === route}
        data-tab={route}
        role="tab"
        aria-selected={activeMainRoute === route}
        aria-controls={`${route}-tab`}
        aria-label={route === 'custom' ? 'Custom Tab' : undefined}
        title={route === 'custom' ? 'Custom Tab' : undefined}
        on:click={() => goTo(route)}
      >
        {#if route === 'custom'}
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M2 6h4"/><path d="M2 10h4"/><path d="M2 14h4"/><path d="M2 18h4"/>
            <rect x="4" y="2" width="16" height="20" rx="2"/>
            <path d="M9 8h8"/><path d="M9 12h8"/><path d="M9 16h5"/>
          </svg>
        {:else}
          {route === 'weekly' ? 'Weekly Tracker' : 'Friends Roster(WIP)'}
        {/if}
      </button>
    {/each}
    </div>

    <div class="header-buttons">
      <RosterSwitcher />
      <button id="settings-btn" class="header-text-btn" class:active={activeMainRoute === 'settings'} class:settings-cta-highlight={highlightSettingsButton} aria-label="Settings" title="Settings" on:click={() => goTo('settings')}>
        Settings
      </button>
    </div>
  </header>

  {#if activeMainRoute === 'weekly'}
    {#await loadWeeklyPage() then weeklyPageModule}
      <svelte:component this={weeklyPageModule.default} />
    {/await}
  {:else if activeMainRoute === 'friends'}
    {#await loadFriendsPage() then friendsPageModule}
      <svelte:component this={friendsPageModule.default} />
    {/await}
  {:else if activeMainRoute === 'custom'}
    {#await loadCustomTabPage() then customPageModule}
      <svelte:component this={customPageModule.default} />
    {/await}
  {:else if activeMainRoute === 'settings'}
    {#await loadSettingsLayout() then settingsLayoutModule}
      <svelte:component
        this={settingsLayoutModule.default}
        section={settingsSection}
        onSelectSection={(next: string) => goTo(`settings/${next}`)}
      />
    {/await}
  {:else}
    <section class="tab-content active" id={`${activeMainRoute}-tab`} aria-live="polite">
      <h2>Route</h2>
      <p>Page in preparation.</p>
    </section>
  {/if}

  {#if isModalRoute(currentRoute) && currentRoute === 'howto'}
    <div id="howto-modal" class="howto-modal" style="display: flex;" role="dialog" aria-modal="true" aria-labelledby="howto-title" tabindex="0" on:click={onOverlayClick} on:keydown={onOverlayKeyDown}>
      <div class="modal-overlay"></div>
      <div class="modal-content howto-content" role="document">
        <button id="howto-close" class="close-btn" aria-label="Close How To Use" on:click={closeModal}>×</button>
        {#await loadHowToPage() then howToPageModule}
          <svelte:component this={howToPageModule.default} />
        {/await}
      </div>
    </div>
  {/if}

  <HowToFab onOpen={() => goTo('howto')} />
</main>
