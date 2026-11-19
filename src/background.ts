const ENABLED_KEY = "enabled";
const LAST_DIAGNOSTIC_KEY = "lastDiagnostic";
const EXCLUDED_URLS_KEY = "excludedUrls";
const POPUP_PLACEMENT_KEY = "popupPlacement";
const NEW_TAB_NEXT_TO_CURRENT_KEY = "newTabNextToCurrent";
const MOVED_POPUP_TABS_KEY = "movedPopupTabsByOpener";
const ACTIVE_TABS_KEY = "activeTabsByWindow";
const DIAGNOSTIC_BADGE_ALARM = "diagnosticBadgeExpiry";
const NORMAL_WINDOW = "normal";
const POPUP_WINDOW = "popup";
const OPENING_ORDER_POPUP_PLACEMENT = "openingOrder";
const BESIDE_CURRENT_POPUP_PLACEMENT = "besideCurrent";
const MAX_MOVE_RETRIES = 4;
const MAX_POPUP_TAB_RETRIES = 12;
const MAX_SETTINGS_LOAD_RETRIES = 3;
const MAX_URL_SETTLE_RETRIES = 20;
const DIAGNOSTIC_BADGE_TTL_MS = 5 * 60 * 1000;
const URL_SETTLE_DELAY_MS = 100;
const PROTECTED_URL_PROTOCOLS = new Set([
  "chrome-extension:",
  "moz-extension:",
  "edge-extension:",
  "extension:",
  "chrome:",
  "chrome-search:",
  "chrome-untrusted:",
  "edge:",
  "devtools:",
  "view-source:",
]);

type PopupPlacement =
  | typeof OPENING_ORDER_POPUP_PLACEMENT
  | typeof BESIDE_CURRENT_POPUP_PLACEMENT;

let enabled = true;
let settingsLoaded = false;
let localSettingsLoaded = false;
let placementStateLoaded = false;
let enabledChangeVersion = 0;
let excludedUrlsChangeVersion = 0;
let popupPlacementChangeVersion = 0;
let newTabPlacementChangeVersion = 0;
let activeTabChangeVersion = 0;
let normalWindowObservation = 0;
let popupOperationGeneration = 0;
let settingsLoadGeneration = 0;
let excludedUrls: string[] = [];
let popupPlacement: PopupPlacement = OPENING_ORDER_POPUP_PLACEMENT;
let newTabNextToCurrent = true;
const lastNormalWindow = new Map<boolean, number>();
const pendingPopups: chrome.windows.Window[] = [];
const pendingCreatedTabs: chrome.tabs.Tab[] = [];
const queuedEndTabWindows: number[] = [];
const endTabCreationsByWindow = new Map<number, Set<Promise<void>>>();
const endTabIds = new Set<number>();
const pendingNewTabUrls = new Map<number, {
  tab: chrome.tabs.Tab;
  referenceTabId?: number;
}>();
type MoveTask = (done: () => void) => void;
const openerMoveQueues = new Map<number, MoveTask[]>();
const movedPopupTabsByOpener = new Map<number, Set<number>>();
const activeTabByWindow = new Map<number, number>();
const previousActiveTabByWindow = new Map<number, number>();

function lastWindowKey(incognito: boolean): string {
  return incognito ? "lastIncognitoWindowId" : "lastRegularWindowId";
}

function rememberNormalWindow(window: chrome.windows.Window): void {
  if (window.type !== NORMAL_WINDOW || window.id === undefined) return;
  if (lastNormalWindow.get(window.incognito) === window.id) return;
  lastNormalWindow.set(window.incognito, window.id);
  chrome.storage.local.set({ [lastWindowKey(window.incognito)]: window.id });
}

function consumeLastError(): boolean {
  return Boolean(chrome.runtime.lastError);
}

function applyEnabled(nextEnabled: boolean): void {
  if (enabled !== nextEnabled) popupOperationGeneration += 1;
  if (!nextEnabled) queuedEndTabWindows.length = 0;
  enabled = nextEnabled;
}

function popupOperationIsActive(generation: number): boolean {
  return enabled && generation === popupOperationGeneration;
}

type DiagnosticStatus = "success" | "retrying" | "warning" | "error";

function recordDiagnostic(
  status: DiagnosticStatus,
  message: string,
  popupWindowId: number,
  targetWindowId: number,
  tabCount: number,
  attempt: number,
): void {
  const diagnostic = {
    status,
    message,
    popupWindowId,
    targetWindowId,
    tabCount,
    attempt,
    timestamp: new Date().toISOString(),
  };
  chrome.storage.local.set({
    [LAST_DIAGNOSTIC_KEY]: {
      ...diagnostic,
    },
  });
  updateDiagnosticBadge(status);
  updateDiagnosticBadgeExpiry(status, diagnostic.timestamp);
}

function diagnosticIsRecent(timestamp?: string): boolean {
  if (!timestamp) return false;
  const time = Date.parse(timestamp);
  const age = Date.now() - time;
  return Number.isFinite(time) && age >= 0 && age < DIAGNOSTIC_BADGE_TTL_MS;
}

function normalizeExcludedUrls(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean))];
}

function normalizePopupPlacement(value: unknown): PopupPlacement {
  return value === BESIDE_CURRENT_POPUP_PLACEMENT
    ? BESIDE_CURRENT_POPUP_PLACEMENT
    : OPENING_ORDER_POPUP_PLACEMENT;
}

function wildcardMatches(value: string, pattern: string, caseSensitive = false): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, caseSensitive ? "" : "i").test(value);
}

function wildcardUrlMatches(url: URL, pattern: string): boolean {
  const authorityStart = pattern.indexOf("://") + 3;
  const suffixCandidates = ["/", "?", "#"]
    .map((separator) => pattern.indexOf(separator, authorityStart))
    .filter((index) => index >= 0);
  const suffixStart = suffixCandidates.length > 0
    ? Math.min(...suffixCandidates)
    : pattern.length;
  const authorityPattern = pattern.slice(0, suffixStart);
  const suffixPattern = pattern.slice(suffixStart);
  const authority = `${url.protocol}//${url.host}`;
  const suffix = `${url.pathname}${url.search}${url.hash}`;
  return wildcardMatches(authority, authorityPattern)
    && wildcardMatches(suffix, suffixPattern, true);
}

function urlMatchesRule(rawUrl: string, rule: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (rule.includes("://")) {
      if (rule.includes("*")) return wildcardUrlMatches(url, rule);
      const ruleUrl = new URL(rule);
      if (url.origin !== ruleUrl.origin) return false;
      const originOnly = ruleUrl.pathname === "/" && !ruleUrl.search && !ruleUrl.hash;
      return originOnly || rawUrl === rule || rawUrl.startsWith(rule);
    }

    const pathStart = rule.indexOf("/");
    const hostnameRule = (pathStart === -1 ? rule : rule.slice(0, pathStart))
      .toLowerCase()
      .replace(/^\.+/, "");
    const pathRule = pathStart === -1 ? undefined : rule.slice(pathStart);
    const hostname = url.hostname.toLowerCase();
    const host = url.host.toLowerCase();
    const hostnameMatches = hostnameRule.includes("*")
      ? wildcardMatches(host, hostnameRule) || wildcardMatches(hostname, hostnameRule)
      : host === hostnameRule
        || hostname === hostnameRule
        || hostname.endsWith(`.${hostnameRule}`);
    if (!hostnameMatches || pathRule === undefined) return hostnameMatches;
    return pathRule.includes("*")
      ? wildcardMatches(url.pathname, pathRule, true)
      : url.pathname === pathRule || url.pathname.startsWith(pathRule);
  } catch {
    return false;
  }
}

function isProtectedBrowserUrl(rawUrl: string): boolean {
  try {
    return PROTECTED_URL_PROTOCOLS.has(new URL(rawUrl).protocol.toLowerCase());
  } catch {
    return false;
  }
}

function popupMatchesExcludedUrl(tabs: chrome.tabs.Tab[]): boolean {
  return tabs.some((tab) => [tab.pendingUrl, tab.url]
    .filter((url): url is string => Boolean(url))
    .some((url) => (
      isProtectedBrowserUrl(url)
      || excludedUrls.some((rule) => urlMatchesRule(url, rule))
    )));
}

function popupUrlMayStillChange(tabs: chrome.tabs.Tab[]): boolean {
  return tabs.some((tab) => {
    const candidate = tab.pendingUrl ?? tab.url;
    return !candidate || candidate === "about:blank";
  });
}

function openerIsProtected(tab: chrome.tabs.Tab): boolean {
  return [tab.pendingUrl, tab.url]
    .filter((url): url is string => Boolean(url))
    .some(isProtectedBrowserUrl);
}

function isTransientMoveError(message: string): boolean {
  return /cannot be edited right now|dragging a tab/i.test(message);
}

function isUnavailableWindowError(message: string): boolean {
  return /no window with id|window not found|invalid window/i.test(message);
}

function updateAction(): void {
  chrome.action.setBadgeText({ text: enabled ? "ON" : "OFF" });
  chrome.action.setBadgeBackgroundColor({ color: enabled ? "#16803c" : "#777777" });
  chrome.action.setTitle({
    title: enabled ? "Popup as Tab: On" : "Popup as Tab: Off",
  });
}

function updateDiagnosticBadge(status: DiagnosticStatus): void {
  if (!enabled) {
    updateAction();
    return;
  }
  if (status === "error") {
    chrome.action.setBadgeText({ text: "ERR" });
    chrome.action.setBadgeBackgroundColor({ color: "#b62c2c" });
  } else if (status === "warning") {
    chrome.action.setBadgeText({ text: "WARN" });
    chrome.action.setBadgeBackgroundColor({ color: "#a86705" });
  } else if (status === "retrying") {
    chrome.action.setBadgeText({ text: "..." });
    chrome.action.setBadgeBackgroundColor({ color: "#a86705" });
  } else {
    updateAction();
  }
}

function updateDiagnosticBadgeExpiry(status: DiagnosticStatus, timestamp?: string): void {
  if (
    (status === "error" || status === "warning")
    && diagnosticIsRecent(timestamp)
  ) {
    const diagnosticTime = Date.parse(timestamp ?? "");
    void chrome.alarms.create(DIAGNOSTIC_BADGE_ALARM, {
      when: diagnosticTime + DIAGNOSTIC_BADGE_TTL_MS,
    });
  } else {
    void chrome.alarms.clear(DIAGNOSTIC_BADGE_ALARM);
  }
}

function loadSettingsAttempt(attempt: number, loadGeneration: number): void {
  const versionAtRequest = enabledChangeVersion;
  const excludedVersionAtRequest = excludedUrlsChangeVersion;
  const popupPlacementVersionAtRequest = popupPlacementChangeVersion;
  const newTabPlacementVersionAtRequest = newTabPlacementChangeVersion;
  chrome.storage.local.get({
    [ENABLED_KEY]: true,
    [LAST_DIAGNOSTIC_KEY]: null,
    [EXCLUDED_URLS_KEY]: [],
    [POPUP_PLACEMENT_KEY]: OPENING_ORDER_POPUP_PLACEMENT,
    [NEW_TAB_NEXT_TO_CURRENT_KEY]: true,
  }, (items) => {
    const loadFailed = consumeLastError();
    if (loadGeneration !== settingsLoadGeneration) return;
    if (loadFailed && attempt < MAX_SETTINGS_LOAD_RETRIES) {
      setTimeout(
        () => loadSettingsAttempt(attempt + 1, loadGeneration),
        100 * (attempt + 1),
      );
      return;
    }
    if (loadFailed) {
      if (versionAtRequest === enabledChangeVersion) applyEnabled(false);
      if (excludedVersionAtRequest === excludedUrlsChangeVersion) excludedUrls = [];
      if (popupPlacementVersionAtRequest === popupPlacementChangeVersion) {
        popupPlacement = OPENING_ORDER_POPUP_PLACEMENT;
      }
      if (newTabPlacementVersionAtRequest === newTabPlacementChangeVersion) {
        newTabNextToCurrent = true;
      }
      updateAction();
      localSettingsLoaded = true;
      finishInitialization();
      return;
    }

    if (versionAtRequest === enabledChangeVersion) {
      applyEnabled(items[ENABLED_KEY] !== false);
    }
    if (excludedVersionAtRequest === excludedUrlsChangeVersion) {
      excludedUrls = normalizeExcludedUrls(items[EXCLUDED_URLS_KEY]);
    }
    if (popupPlacementVersionAtRequest === popupPlacementChangeVersion) {
      popupPlacement = normalizePopupPlacement(items[POPUP_PLACEMENT_KEY]);
    }
    if (
      newTabPlacementVersionAtRequest === newTabPlacementChangeVersion
    ) {
      newTabNextToCurrent = items[NEW_TAB_NEXT_TO_CURRENT_KEY] !== false;
    }

    const diagnostic = items[LAST_DIAGNOSTIC_KEY] as
      | { status?: DiagnosticStatus; timestamp?: string }
      | null;
    if (
      diagnosticIsRecent(diagnostic?.timestamp)
      && (diagnostic?.status === "error" || diagnostic?.status === "warning")
    ) {
      updateDiagnosticBadge(diagnostic.status);
      updateDiagnosticBadgeExpiry(diagnostic.status, diagnostic.timestamp);
    } else {
      updateAction();
      void chrome.alarms.clear(DIAGNOSTIC_BADGE_ALARM);
    }

    localSettingsLoaded = true;
    finishInitialization();
  });
}

function loadSettings(): void {
  settingsLoadGeneration += 1;
  loadSettingsAttempt(0, settingsLoadGeneration);
}

function normalizeMovedPopupTabs(value: unknown): Map<number, Set<number>> {
  const normalized = new Map<number, Set<number>>();
  if (!value || typeof value !== "object" || Array.isArray(value)) return normalized;

  for (const [rawOpenerId, rawTabIds] of Object.entries(value)) {
    const openerTabId = Number(rawOpenerId);
    if (!Number.isInteger(openerTabId) || !Array.isArray(rawTabIds)) continue;
    const tabIds = rawTabIds.filter((tabId): tabId is number => (
      typeof tabId === "number" && Number.isInteger(tabId)
    ));
    if (tabIds.length > 0) normalized.set(openerTabId, new Set(tabIds));
  }
  return normalized;
}

function normalizeActiveTabs(value: unknown): Map<number, number> {
  const normalized = new Map<number, number>();
  if (!value || typeof value !== "object" || Array.isArray(value)) return normalized;

  for (const [rawWindowId, rawTabId] of Object.entries(value)) {
    const windowId = Number(rawWindowId);
    if (
      Number.isInteger(windowId)
      && typeof rawTabId === "number"
      && Number.isInteger(rawTabId)
    ) {
      normalized.set(windowId, rawTabId);
    }
  }
  return normalized;
}

function persistActiveTabs(): void {
  const serialized: Record<string, number> = {};
  for (const [windowId, tabId] of activeTabByWindow) {
    serialized[String(windowId)] = tabId;
  }
  chrome.storage.session.set({ [ACTIVE_TABS_KEY]: serialized });
}

function rememberActiveTab(tabId: number, windowId: number): void {
  const currentTabId = activeTabByWindow.get(windowId);
  if (currentTabId === tabId) return;
  activeTabChangeVersion += 1;
  if (currentTabId !== undefined) previousActiveTabByWindow.set(windowId, currentTabId);
  activeTabByWindow.set(windowId, tabId);
  persistActiveTabs();
}

function loadPlacementState(): void {
  const activeVersionAtRequest = activeTabChangeVersion;
  chrome.storage.session.get({
    [MOVED_POPUP_TABS_KEY]: {},
    [ACTIVE_TABS_KEY]: {},
  }, (items) => {
    const loadFailed = consumeLastError();
    if (!loadFailed) {
      movedPopupTabsByOpener.clear();
      for (const [openerTabId, tabIds] of normalizeMovedPopupTabs(items[MOVED_POPUP_TABS_KEY])) {
        movedPopupTabsByOpener.set(openerTabId, tabIds);
      }
      const storedActiveTabs = normalizeActiveTabs(items[ACTIVE_TABS_KEY]);
      if (activeVersionAtRequest === activeTabChangeVersion) {
        activeTabByWindow.clear();
        for (const [windowId, tabId] of storedActiveTabs) {
          activeTabByWindow.set(windowId, tabId);
        }
      } else {
        for (const [windowId, storedTabId] of storedActiveTabs) {
          const currentTabId = activeTabByWindow.get(windowId);
          if (currentTabId === undefined) {
            activeTabByWindow.set(windowId, storedTabId);
          } else if (currentTabId !== storedTabId) {
            previousActiveTabByWindow.set(windowId, storedTabId);
          }
        }
      }
    }

    const finishPlacementLoad = (): void => {
      placementStateLoaded = true;
      finishInitialization();
    };
    if (activeTabByWindow.size > 0) {
      finishPlacementLoad();
      return;
    }

    const seedVersion = activeTabChangeVersion;
    chrome.tabs.query({ active: true }, (tabs) => {
      if (!consumeLastError()) {
        for (const tab of tabs) {
          if (tab.id === undefined) continue;
          const currentTabId = activeTabByWindow.get(tab.windowId);
          if (seedVersion === activeTabChangeVersion || currentTabId === undefined) {
            activeTabByWindow.set(tab.windowId, tab.id);
          } else if (currentTabId !== tab.id) {
            previousActiveTabByWindow.set(tab.windowId, tab.id);
          }
        }
        if (activeTabByWindow.size > 0) persistActiveTabs();
      }
      finishPlacementLoad();
    });
  });
}

function finishInitialization(): void {
  if (settingsLoaded || !localSettingsLoaded || !placementStateLoaded) return;
  settingsLoaded = true;
  const queued = pendingPopups.splice(0);
  const queuedTabs = pendingCreatedTabs.splice(0);
  if (enabled) {
    for (const popup of queued) normalizePopup(popup);
    for (const tab of queuedTabs) handleCreatedTab(tab);
    for (const windowId of queuedEndTabWindows.splice(0)) openTabAtEnd(windowId);
  }
}

function persistMovedPopupTabs(): void {
  const serialized: Record<string, number[]> = {};
  for (const [openerTabId, tabIds] of movedPopupTabsByOpener) {
    if (tabIds.size > 0) serialized[String(openerTabId)] = [...tabIds];
  }
  chrome.storage.session.set({ [MOVED_POPUP_TABS_KEY]: serialized });
}

function rememberMovedPopupTabs(openerTabId: number, tabIds: number[]): void {
  const remembered = movedPopupTabsByOpener.get(openerTabId) ?? new Set<number>();
  for (const tabId of tabIds) remembered.add(tabId);
  movedPopupTabsByOpener.set(openerTabId, remembered);
  persistMovedPopupTabs();
}

function enqueueOpenerMove(openerTabId: number, task: MoveTask): void {
  const queue = openerMoveQueues.get(openerTabId) ?? [];
  queue.push(task);
  openerMoveQueues.set(openerTabId, queue);
  if (queue.length !== 1) return;

  const runNext = (): void => {
    const currentQueue = openerMoveQueues.get(openerTabId);
    const current = currentQueue?.[0];
    if (!currentQueue || !current) {
      openerMoveQueues.delete(openerTabId);
      return;
    }
    current(() => {
      currentQueue.shift();
      if (currentQueue.length === 0) {
        openerMoveQueues.delete(openerTabId);
      } else {
        runNext();
      }
    });
  };

  runNext();
}

function rememberIfNormal(windowId: number): void {
  const observation = ++normalWindowObservation;
  chrome.windows.get(windowId, (window) => {
    if (consumeLastError()) return;
    if (observation !== normalWindowObservation) return;
    rememberNormalWindow(window);
  });
}

function findFallbackWindow(
  incognito: boolean,
  callback: (windowId?: number) => void,
  excludedWindowId?: number,
): void {
  const storageKey = lastWindowKey(incognito);

  const findOpenWindow = (): void => {
    chrome.windows.getAll({ windowTypes: [NORMAL_WINDOW] }, (windows) => {
      if (consumeLastError()) {
        callback();
        return;
      }
      const candidates = windows.filter((window) => (
        window.id !== undefined
        && window.id !== excludedWindowId
        && window.type === NORMAL_WINDOW
        && window.incognito === incognito
      ));
      const target = candidates.find((window) => window.focused)
        ?? candidates.sort((left, right) => (right.id ?? 0) - (left.id ?? 0))[0];
      if (target?.id !== undefined) rememberNormalWindow(target);
      callback(target?.id);
    });
  };

  const validateWindow = (windowId: number): void => {
    if (windowId === excludedWindowId) {
      findOpenWindow();
      return;
    }
    chrome.windows.get(windowId, (window) => {
      if (
        !consumeLastError()
        && window.type === NORMAL_WINDOW
        && window.incognito === incognito
      ) {
        callback(windowId);
        return;
      }
      lastNormalWindow.delete(incognito);
      chrome.storage.local.set({ [storageKey]: null }, findOpenWindow);
    });
  };

  const remembered = lastNormalWindow.get(incognito);
  if (remembered !== undefined) {
    validateWindow(remembered);
    return;
  }

  chrome.storage.local.get({ [storageKey]: null }, (items) => {
    if (consumeLastError()) {
      findOpenWindow();
      return;
    }
    const storedWindowId = items[storageKey];
    if (typeof storedWindowId === "number") {
      lastNormalWindow.set(incognito, storedWindowId);
      validateWindow(storedWindowId);
    } else {
      findOpenWindow();
    }
  });
}

function moveTabsToWindow(
  tabIds: number[],
  targetWindowId: number,
  popupWindowId: number,
  moveIndex: number,
  activeTabId: number | undefined,
  targetGroupId: number | undefined,
  groupMoveIndex: number | undefined,
  openerTabId: number | undefined,
  operationGeneration: number,
  onComplete: () => void,
  onTargetUnavailable?: () => void,
  attempt = 1,
): void {
  if (!popupOperationIsActive(operationGeneration)) {
    onComplete();
    return;
  }
  if (tabIds.length === 0) {
    onComplete();
    return;
  }
  chrome.tabs.move(tabIds, { windowId: targetWindowId, index: moveIndex }, () => {
    const moveError = chrome.runtime.lastError?.message;
    if (!popupOperationIsActive(operationGeneration)) {
      onComplete();
      return;
    }
    if (moveError) {
      if (isTransientMoveError(moveError) && attempt <= MAX_MOVE_RETRIES) {
        recordDiagnostic(
          "retrying",
          `Temporary tab move failure; retrying: ${moveError}`,
          popupWindowId,
          targetWindowId,
          tabIds.length,
          attempt,
        );
        setTimeout(
          () => moveTabsToWindow(
            tabIds,
            targetWindowId,
            popupWindowId,
            moveIndex,
            activeTabId,
            targetGroupId,
            groupMoveIndex,
            openerTabId,
            operationGeneration,
            onComplete,
            onTargetUnavailable,
            attempt + 1,
          ),
          50 * attempt,
        );
        return;
      }

      if (onTargetUnavailable && isUnavailableWindowError(moveError)) {
        onTargetUnavailable();
        return;
      }

      const unsupportedPopupMove = /only be moved to and from normal windows/i.test(moveError);
      recordDiagnostic(
        "error",
        unsupportedPopupMove
          ? `The browser does not support moving tabs out of popup windows: ${moveError}`
          : `Failed to move tabs: ${moveError}`,
        popupWindowId,
        targetWindowId,
        tabIds.length,
        attempt,
      );
      onComplete();
      return;
    }

    if (openerTabId !== undefined) rememberMovedPopupTabs(openerTabId, tabIds);

    const finishPlacement = (placementErrors: string[]): void => {
      if (!popupOperationIsActive(operationGeneration)) {
        onComplete();
        return;
      }
      const movedTabId = activeTabId !== undefined && tabIds.includes(activeTabId)
        ? activeTabId
        : tabIds[tabIds.length - 1];
      const operationErrors = [...placementErrors];
      const operations: Array<(done: (operation: string) => void) => void> = [];

      operations.push((done) => {
        chrome.tabs.update(movedTabId, { active: true }, () => done("activate moved tab"));
      });
      operations.push((done) => {
        chrome.windows.update(targetWindowId, { focused: true }, () => done("focus target window"));
      });
      let pendingOperations = operations.length;
      const finishOperation = (operation: string): void => {
        const error = chrome.runtime.lastError?.message;
        if (error) operationErrors.push(`${operation}: ${error}`);
        pendingOperations -= 1;
        if (pendingOperations !== 0) return;

        if (!popupOperationIsActive(operationGeneration)) {
          onComplete();
          return;
        }

        recordDiagnostic(
          operationErrors.length === 0 ? "success" : "warning",
          operationErrors.length === 0
            ? "Moved popup tabs and restored focus"
            : `Moved tabs, but some post-move operations failed: ${operationErrors.join("; ")}`,
          popupWindowId,
          targetWindowId,
          tabIds.length,
          attempt,
        );
        onComplete();
      };

      for (const operation of operations) operation(finishOperation);
    };

    const applyGroupAndFinish = (placementErrors: string[]): void => {
      if (!popupOperationIsActive(operationGeneration)) {
        onComplete();
        return;
      }
      if (targetGroupId === undefined || targetGroupId < 0) {
        finishPlacement(placementErrors);
        return;
      }

      chrome.tabs.group({ tabIds, groupId: targetGroupId }, () => {
        const groupError = chrome.runtime.lastError?.message;
        if (!popupOperationIsActive(operationGeneration)) {
          onComplete();
          return;
        }
        if (groupError) {
          placementErrors.push(`apply opener tab group: ${groupError}`);
          finishPlacement(placementErrors);
          return;
        }
        if (groupMoveIndex === undefined) {
          finishPlacement(placementErrors);
          return;
        }

        chrome.tabs.move(tabIds, { windowId: targetWindowId, index: groupMoveIndex }, () => {
          const repositionError = chrome.runtime.lastError?.message;
          if (!popupOperationIsActive(operationGeneration)) {
            onComplete();
            return;
          }
          if (repositionError) {
            placementErrors.push(`reposition grouped tabs: ${repositionError}`);
          }
          finishPlacement(placementErrors);
        });
      });
    };

    applyGroupAndFinish([]);
  });
}

function prepareTabMove(
  tabIds: number[],
  targetWindowId: number,
  popupWindowId: number,
  activeTabId: number | undefined,
  incognito: boolean,
  operationGeneration: number,
  onComplete: () => void,
  openerTabId?: number,
  allowFallback = true,
): void {
  if (!popupOperationIsActive(operationGeneration)) {
    onComplete();
    return;
  }
  const moveToFallback = (): void => {
    if (!popupOperationIsActive(operationGeneration)) {
      onComplete();
      return;
    }
    if (!allowFallback) {
      recordDiagnostic(
        "error",
        "Failed to move tabs: no available normal window was found.",
        popupWindowId,
        targetWindowId,
        tabIds.length,
        1,
      );
      onComplete();
      return;
    }
    findFallbackWindow(incognito, (fallbackWindowId) => {
      if (!popupOperationIsActive(operationGeneration)) {
        onComplete();
        return;
      }
      if (fallbackWindowId === undefined) {
        recordDiagnostic(
          "error",
          "Failed to move tabs: no available normal window was found.",
          popupWindowId,
          targetWindowId,
          tabIds.length,
          1,
        );
        onComplete();
        return;
      }
      prepareTabMove(
        tabIds,
        fallbackWindowId,
        popupWindowId,
        activeTabId,
        incognito,
        operationGeneration,
        onComplete,
        undefined,
        false,
      );
    }, targetWindowId);
  };

  chrome.tabs.query({ windowId: targetWindowId }, (targetTabs) => {
    const queryFailed = consumeLastError();
    if (!popupOperationIsActive(operationGeneration)) {
      onComplete();
      return;
    }
    if (queryFailed) {
      moveToFallback();
      return;
    }

    let referenceIndex: number | undefined;
    let targetGroupId: number | undefined;
    let groupMoveIndex: number | undefined;
    if (openerTabId !== undefined) {
      const openerTab = targetTabs.find((tab) => tab.id === openerTabId);
      if (!openerTab) {
        moveToFallback();
        return;
      }
      referenceIndex = openerTab.index;
      if (popupPlacement === OPENING_ORDER_POPUP_PLACEMENT) {
        const movedPopupTabIds = movedPopupTabsByOpener.get(openerTabId);
        referenceIndex = targetTabs
          .filter((tab) => movedPopupTabIds?.has(tab.id ?? -1))
          .reduce((lastIndex, tab) => Math.max(lastIndex, tab.index), referenceIndex);
      }
      const desiredMoveIndex = referenceIndex + 1;
      if (openerTab.pinned) {
        const lastPinnedIndex = targetTabs
          .filter((tab) => tab.pinned)
          .reduce((lastIndex, tab) => Math.max(lastIndex, tab.index), referenceIndex);
        referenceIndex = lastPinnedIndex;
      }
      targetGroupId = openerTab.groupId;
      if (targetGroupId !== undefined && targetGroupId >= 0) {
        const lastGroupIndex = targetTabs
          .filter((tab) => tab.groupId === targetGroupId)
          .reduce((lastIndex, tab) => Math.max(lastIndex, tab.index), referenceIndex);
        if (lastGroupIndex > referenceIndex) {
          referenceIndex = lastGroupIndex;
          groupMoveIndex = desiredMoveIndex;
        }
      }
    } else {
      referenceIndex = targetTabs.find((tab) => tab.active)?.index;
    }

    const moveIndex = referenceIndex === undefined ? -1 : referenceIndex + 1;
    moveTabsToWindow(
      tabIds,
      targetWindowId,
      popupWindowId,
      moveIndex,
      activeTabId,
      targetGroupId,
      groupMoveIndex,
      openerTabId,
      operationGeneration,
      onComplete,
      allowFallback ? moveToFallback : undefined,
    );
  });
}

function moveNewTab(
  tabId: number,
  windowId: number,
  index: number,
  callback?: () => void,
): void {
  chrome.tabs.move(tabId, { windowId, index }, () => {
    if (!consumeLastError()) callback?.();
  });
}

function isNewTabPageUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    const protocol = url.protocol.toLowerCase();
    const hostname = url.hostname.toLowerCase();
    return (
      ((protocol === "chrome:" || protocol === "edge:")
        && (hostname === "newtab" || hostname === "new-tab-page"))
      || (protocol === "chrome-search:"
        && (hostname === "local-ntp" || hostname === "new-tab-page"))
    );
  } catch {
    return false;
  }
}

function newTabUrlMayStillChange(urls: string[]): boolean {
  return urls.length === 0 || urls.every((url) => url === "about:blank");
}

function createdTabReferenceId(tab: chrome.tabs.Tab): number | undefined {
  if (tab.openerTabId !== undefined && tab.openerTabId !== tab.id) {
    return tab.openerTabId;
  }
  const rememberedTabId = activeTabByWindow.get(tab.windowId);
  return rememberedTabId === tab.id
    ? previousActiveTabByWindow.get(tab.windowId)
    : rememberedTabId;
}

function handleCreatedTab(tab: chrome.tabs.Tab): void {
  if (!enabled || !newTabNextToCurrent || tab.id === undefined) return;
  const urls = [tab.pendingUrl, tab.url]
    .filter((url): url is string => Boolean(url));
  const referenceTabId = createdTabReferenceId(tab);
  if (urls.some(isNewTabPageUrl)) {
    scheduleNewTabPlacement(tab, referenceTabId);
  } else if (newTabUrlMayStillChange(urls)) {
    pendingNewTabUrls.set(tab.id, { tab, referenceTabId });
  }
}

function handlePendingNewTabUrl(
  tabId: number,
  changeInfo: { url?: string },
  tab: chrome.tabs.Tab,
): void {
  const pending = pendingNewTabUrls.get(tabId);
  if (!pending) return;
  const urls = [changeInfo.url, tab.pendingUrl, tab.url]
    .filter((url): url is string => Boolean(url));
  if (newTabUrlMayStillChange(urls)) return;

  pendingNewTabUrls.delete(tabId);
  if (enabled && newTabNextToCurrent && urls.some(isNewTabPageUrl)) {
    scheduleNewTabPlacement(tab, pending.referenceTabId);
  }
}

function scheduleNewTabPlacement(tab: chrome.tabs.Tab, referenceTabId?: number): void {
  // onCreated can precede the create response. Only requests already issued in
  // this window could have created this tab.
  const pending = endTabCreationsByWindow.get(tab.windowId);
  if (pending) {
    void Promise.all(pending).then(() => placeNewTabPageAfterCurrent(tab, referenceTabId));
  } else {
    placeNewTabPageAfterCurrent(tab, referenceTabId);
  }
}

function placeNewTabPageAfterCurrent(
  tab: chrome.tabs.Tab,
  capturedReferenceTabId?: number,
): void {
  if (!enabled || !newTabNextToCurrent || tab.id === undefined) return;
  const tabId = tab.id;
  if (endTabIds.delete(tabId)) return;

  chrome.windows.get(tab.windowId, (window) => {
    if (
      consumeLastError()
      || window.type !== NORMAL_WINDOW
      || !enabled
      || !newTabNextToCurrent
    ) return;

    const rememberedTabId = activeTabByWindow.get(tab.windowId);
    const previousTabId = rememberedTabId === tabId
      ? previousActiveTabByWindow.get(tab.windowId)
      : rememberedTabId;

    chrome.tabs.query({ windowId: tab.windowId }, (tabs) => {
      if (consumeLastError() || !enabled || !newTabNextToCurrent) return;
      const createdTab = tabs.find((candidate) => candidate.id === tabId);
      if (!createdTab) return;

      const referenceTab = tabs.find((candidate) => candidate.id === capturedReferenceTabId)
        ?? tabs.find((candidate) => candidate.id === previousTabId);
      if (!referenceTab || referenceTab.id === tabId) return;
      if (!referenceTab.pinned && createdTab.pinned) return;

      let placementReferenceIndex = referenceTab.index;
      if (referenceTab.pinned && !createdTab.pinned) {
        placementReferenceIndex = tabs
          .filter((candidate) => candidate.pinned)
          .reduce((lastIndex, candidate) => Math.max(lastIndex, candidate.index), referenceTab.index);
      }

      const desiredIndex = placementReferenceIndex
        + (createdTab.index > placementReferenceIndex ? 1 : 0);
      const targetGroupId = referenceTab.pinned ? undefined : referenceTab.groupId;
      if (targetGroupId === undefined || targetGroupId < 0 || createdTab.groupId === targetGroupId) {
        if (createdTab.index !== desiredIndex) {
          moveNewTab(tabId, tab.windowId, desiredIndex);
        }
        return;
      }

      const lastGroupIndex = tabs
        .filter((candidate) => candidate.groupId === targetGroupId)
        .reduce((lastIndex, candidate) => Math.max(lastIndex, candidate.index), referenceTab.index);
      const safeIndex = lastGroupIndex + (createdTab.index > lastGroupIndex ? 1 : 0);
      moveNewTab(tabId, tab.windowId, safeIndex, () => {
        chrome.tabs.group({ tabIds: tabId, groupId: targetGroupId }, () => {
          if (consumeLastError()) return;
          moveNewTab(tabId, tab.windowId, desiredIndex);
        });
      });
    });
  });
}

function normalizePopup(
  popup: chrome.windows.Window,
  attempt = 0,
  urlSettleAttempt = 0,
  operationGeneration = popupOperationGeneration,
): void {
  if (!popupOperationIsActive(operationGeneration) || popup.id === undefined) return;
  const popupWindowId = popup.id;

  chrome.tabs.query({ windowId: popupWindowId }, (popupTabs) => {
    const queryFailed = consumeLastError();
    if (!popupOperationIsActive(operationGeneration) || queryFailed) return;

    // onCreated can arrive just before the first tab is attached to the window.
    if (popupTabs.length === 0 && attempt < MAX_POPUP_TAB_RETRIES) {
      setTimeout(
        () => normalizePopup(popup, attempt + 1, urlSettleAttempt, operationGeneration),
        50 * (attempt + 1),
      );
      return;
    }

    const tabIds = [...popupTabs]
      .sort((left, right) => left.index - right.index)
      .flatMap((tab) => (tab.id === undefined ? [] : [tab.id]));
    if (tabIds.length === 0) {
      recordDiagnostic(
        "error",
        "No movable tab was found after waiting for the popup tab to attach.",
        popupWindowId,
        -1,
        0,
        attempt + 1,
      );
      return;
    }

    if (popupMatchesExcludedUrl(popupTabs)) return;
    const activeTabId = popupTabs.find((tab) => tab.active)?.id ?? tabIds[0];
    const openerTabId = popupTabs.find((tab) => tab.openerTabId !== undefined)?.openerTabId;
    if (
      urlSettleAttempt < MAX_URL_SETTLE_RETRIES
      && popupUrlMayStillChange(popupTabs)
    ) {
      const retryAfterUrlSettle = (): void => {
        setTimeout(
          () => normalizePopup(popup, attempt, urlSettleAttempt + 1, operationGeneration),
          URL_SETTLE_DELAY_MS,
        );
      };
      if (openerTabId !== undefined) {
        chrome.tabs.get(openerTabId, (openerTab) => {
          const openerLookupFailed = consumeLastError();
          if (!popupOperationIsActive(operationGeneration)) return;
          if (
            !openerLookupFailed
            && openerTab.windowId !== popupWindowId
            && openerIsProtected(openerTab)
          ) return;
          retryAfterUrlSettle();
        });
      } else {
        retryAfterUrlSettle();
      }
      return;
    }

    const moveToFallback = (onComplete: () => void): void => {
      if (!popupOperationIsActive(operationGeneration)) {
        onComplete();
        return;
      }
      findFallbackWindow(popup.incognito, (targetId) => {
        if (!popupOperationIsActive(operationGeneration)) {
          onComplete();
          return;
        }
        if (targetId === undefined) {
          recordDiagnostic(
            "error",
            "Failed to move tabs: no available normal window was found.",
            popupWindowId,
            -1,
            tabIds.length,
            1,
          );
          onComplete();
          return;
        }
        prepareTabMove(
          tabIds,
          targetId,
          popupWindowId,
          activeTabId,
          popup.incognito,
          operationGeneration,
          onComplete,
        );
      }, popupWindowId);
    };

    if (openerTabId !== undefined) {
      enqueueOpenerMove(openerTabId, (onComplete) => {
        if (!popupOperationIsActive(operationGeneration)) {
          onComplete();
          return;
        }
        chrome.tabs.get(openerTabId, (openerTab) => {
          const openerLookupFailed = consumeLastError();
          if (!popupOperationIsActive(operationGeneration)) {
            onComplete();
            return;
          }
          if (!openerLookupFailed && openerTab.windowId !== popupWindowId) {
            if (openerIsProtected(openerTab)) {
              onComplete();
              return;
            }
            prepareTabMove(
              tabIds,
              openerTab.windowId,
              popupWindowId,
              activeTabId,
              popup.incognito,
              operationGeneration,
              onComplete,
              openerTabId,
            );
            return;
          }
          moveToFallback(onComplete);
        });
      });
      return;
    }

    moveToFallback(() => {});
  });
}

chrome.windows.onCreated.addListener((window) => {
  if (window.type === NORMAL_WINDOW && window.id !== undefined) {
    normalWindowObservation += 1;
    rememberNormalWindow(window);
  } else if (window.type === POPUP_WINDOW) {
    if (settingsLoaded) {
      normalizePopup(window);
    } else {
      pendingPopups.push(window);
    }
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== DIAGNOSTIC_BADGE_ALARM) return;
  chrome.storage.local.get({ [LAST_DIAGNOSTIC_KEY]: null }, (items) => {
    if (consumeLastError()) {
      updateAction();
      return;
    }
    const diagnostic = items[LAST_DIAGNOSTIC_KEY] as
      | { status?: DiagnosticStatus; timestamp?: string }
      | null;
    if (
      diagnosticIsRecent(diagnostic?.timestamp)
      && (diagnostic?.status === "error" || diagnostic?.status === "warning")
    ) {
      updateDiagnosticBadge(diagnostic.status);
      updateDiagnosticBadgeExpiry(diagnostic.status, diagnostic.timestamp);
      return;
    }
    updateAction();
    void chrome.alarms.clear(DIAGNOSTIC_BADGE_ALARM);
  });
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId !== chrome.windows.WINDOW_ID_NONE) rememberIfNormal(windowId);
});

function openTabAtEnd(windowId: number): void {
  if (!enabled) return;
  if (!settingsLoaded) {
    queuedEndTabWindows.push(windowId);
    return;
  }
  const pending = endTabCreationsByWindow.get(windowId) ?? new Set<Promise<void>>();
  endTabCreationsByWindow.set(windowId, pending);
  // Chrome clamps the index to the tab count at insertion time.
  const creation = chrome.tabs.create({ windowId, index: 0x7fffffff, active: true })
    .then((created) => {
      if (created.id !== undefined) endTabIds.add(created.id);
    })
    .catch((error) => console.warn("Could not open a tab at the end of the window.", error))
    .finally(() => {
      pending.delete(creation);
      if (pending.size === 0) endTabCreationsByWindow.delete(windowId);
    });
  pending.add(creation);
}

chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== "open-tab-at-end" || !enabled) return;
  if (tab) {
    openTabAtEnd(tab.windowId);
    return;
  }
  const version = enabledChangeVersion;
  chrome.windows.getCurrent((window) => {
    if (!consumeLastError() && window?.id !== undefined && version === enabledChangeVersion) {
      openTabAtEnd(window.id);
    }
  });
});

chrome.tabs.onCreated.addListener((tab) => {
  if (settingsLoaded) {
    handleCreatedTab(tab);
  } else {
    pendingCreatedTabs.push(tab);
  }
});

chrome.tabs.onUpdated.addListener(handlePendingNewTabUrl);

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  rememberActiveTab(tabId, windowId);
  rememberIfNormal(windowId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  endTabIds.delete(tabId);
  pendingNewTabUrls.delete(tabId);
  let changed = movedPopupTabsByOpener.delete(tabId);
  for (const [openerTabId, tabIds] of movedPopupTabsByOpener) {
    if (!tabIds.delete(tabId)) continue;
    changed = true;
    if (tabIds.size === 0) movedPopupTabsByOpener.delete(openerTabId);
  }
  if (changed) persistMovedPopupTabs();

  let activeTabsChanged = false;
  for (const [windowId, activeTabId] of activeTabByWindow) {
    if (activeTabId !== tabId) continue;
    activeTabByWindow.delete(windowId);
    activeTabsChanged = true;
  }
  if (activeTabsChanged) activeTabChangeVersion += 1;
  for (const [windowId, previousTabId] of previousActiveTabByWindow) {
    if (previousTabId === tabId) previousActiveTabByWindow.delete(windowId);
  }
  if (activeTabsChanged) persistActiveTabs();
});

chrome.windows.onRemoved.addListener((windowId) => {
  normalWindowObservation += 1;
  const activeTabsChanged = activeTabByWindow.delete(windowId);
  previousActiveTabByWindow.delete(windowId);
  if (activeTabsChanged) {
    activeTabChangeVersion += 1;
    persistActiveTabs();
  }
  for (const [incognito, rememberedId] of lastNormalWindow) {
    if (rememberedId === windowId) {
      lastNormalWindow.delete(incognito);
      chrome.storage.local.set({ [lastWindowKey(incognito)]: null });
    }
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (changes[ENABLED_KEY]) {
    enabledChangeVersion += 1;
    applyEnabled(changes[ENABLED_KEY].newValue !== false);
    updateAction();
  }
  if (changes[EXCLUDED_URLS_KEY]) {
    excludedUrlsChangeVersion += 1;
    excludedUrls = normalizeExcludedUrls(changes[EXCLUDED_URLS_KEY].newValue);
  }
  if (changes[POPUP_PLACEMENT_KEY]) {
    popupPlacementChangeVersion += 1;
    popupPlacement = normalizePopupPlacement(changes[POPUP_PLACEMENT_KEY].newValue);
  }
  if (changes[NEW_TAB_NEXT_TO_CURRENT_KEY]) {
    newTabPlacementChangeVersion += 1;
    newTabNextToCurrent = changes[NEW_TAB_NEXT_TO_CURRENT_KEY].newValue !== false;
    if (!newTabNextToCurrent) pendingNewTabUrls.clear();
  }
  if (changes[LAST_DIAGNOSTIC_KEY]) {
    const diagnostic = changes[LAST_DIAGNOSTIC_KEY].newValue as
      | { status?: DiagnosticStatus; timestamp?: string }
      | undefined;
    if (diagnostic?.status) {
      updateDiagnosticBadge(diagnostic.status);
      updateDiagnosticBadgeExpiry(diagnostic.status, diagnostic.timestamp);
    }
  }
});

chrome.runtime.onInstalled.addListener(loadSettings);
chrome.runtime.onStartup.addListener(loadSettings);
loadPlacementState();
loadSettings();
