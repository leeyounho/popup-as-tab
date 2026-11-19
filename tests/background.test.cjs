const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const workerCode = fs.readFileSync(
  path.join(__dirname, "..", "dist", "background.js"),
  "utf8",
);

function createEvent() {
  const listeners = [];
  return {
    addListener(listener) {
      listeners.push(listener);
    },
    emit(...args) {
      for (const listener of listeners) listener(...args);
    },
  };
}

function createHarness(options = {}) {
  const stored = { ...(options.storage || {}) };
  const sessionStored = { ...(options.sessionStorage || {}) };
  const windowMap = new Map((options.windows || []).map((window) => [window.id, { ...window }]));
  const hydrateTab = (tab) => ({
    active: false,
    index: 0,
    url: "https://example.test/",
    ...tab,
  });
  const tabMap = new Map((options.tabs || []).map((tab) => [tab.id, hydrateTab(tab)]));
  let queryCount = 0;
  let moveCount = 0;
  let storageGetCount = 0;
  const pendingMoves = [];
  const pendingQueries = [];
  const pendingStorageGets = [];

  const calls = {
    alarms: [],
    badges: [],
    clearedAlarms: [],
    colors: [],
    groups: [],
    moves: [],
    storageSets: [],
    sessionStorageSets: [],
    tabUpdates: [],
    timeouts: [],
    titles: [],
    windowUpdates: [],
  };

  const events = {
    alarm: createEvent(),
    command: createEvent(),
    installed: createEvent(),
    startup: createEvent(),
    storageChanged: createEvent(),
    tabActivated: createEvent(),
    tabCreated: createEvent(),
    tabRemoved: createEvent(),
    tabUpdated: createEvent(),
    windowCreated: createEvent(),
    windowFocusChanged: createEvent(),
    windowRemoved: createEvent(),
  };

  let pendingLastError;
  const runtime = {
    onInstalled: events.installed,
    onStartup: events.startup,
    get lastError() {
      const error = pendingLastError;
      pendingLastError = undefined;
      return error;
    },
    set lastError(error) {
      pendingLastError = error;
    },
  };

  function failCallback(message, callback, value) {
    runtime.lastError = { message };
    callback(value);
    runtime.lastError = undefined;
  }

  const chrome = {
    commands: { onCommand: events.command },
    alarms: {
      onAlarm: events.alarm,
      create(name, alarmInfo) {
        calls.alarms.push({ name, ...alarmInfo });
        return Promise.resolve();
      },
      clear(name) {
        calls.clearedAlarms.push(name);
        return Promise.resolve(true);
      },
    },
    runtime,
    storage: {
      onChanged: events.storageChanged,
      local: {
        get(defaults, callback) {
          storageGetCount += 1;
          if (options.deferInitialStorageGet && storageGetCount === 1) {
            pendingStorageGets.push({ defaults, callback });
            return;
          }
          if (storageGetCount <= (options.failInitialStorageGets || 0)) {
            failCallback("Storage unavailable", callback, { ...defaults });
            return;
          }
          const result = {};
          for (const [key, fallback] of Object.entries(defaults)) {
            result[key] = Object.hasOwn(stored, key) ? stored[key] : fallback;
          }
          callback(result);
        },
        set(items, callback) {
          Object.assign(stored, items);
          calls.storageSets.push({ ...items });
          if (callback) callback();
        },
      },
      session: {
        get(defaults, callback) {
          const result = {};
          for (const [key, fallback] of Object.entries(defaults)) {
            result[key] = Object.hasOwn(sessionStored, key) ? sessionStored[key] : fallback;
          }
          callback(result);
        },
        set(items, callback) {
          Object.assign(sessionStored, items);
          calls.sessionStorageSets.push({ ...items });
          if (callback) callback();
        },
      },
    },
    action: {
      setBadgeText(details) {
        calls.badges.push(details.text);
      },
      setBadgeBackgroundColor(details) {
        calls.colors.push(details.color);
      },
      setTitle(details) {
        calls.titles.push(details.title);
      },
    },
    windows: {
      WINDOW_ID_NONE: -1,
      onCreated: events.windowCreated,
      onFocusChanged: events.windowFocusChanged,
      onRemoved: events.windowRemoved,
      getCurrent(callback) {
        callback([...windowMap.values()].find((window) => window.focused));
      },
      get(windowId, callback) {
        const window = windowMap.get(windowId);
        if (!window) {
          failCallback("Window not found", callback, undefined);
          return;
        }
        callback({ ...window });
      },
      getAll(_getInfo, callback) {
        callback([...windowMap.values()].map((window) => ({ ...window })));
      },
      update(windowId, updateInfo, callback) {
        const window = windowMap.get(windowId);
        if (!window) {
          failCallback("Window not found", callback || (() => {}), undefined);
          return;
        }
        Object.assign(window, updateInfo);
        calls.windowUpdates.push({ windowId, ...updateInfo });
        if (callback) callback({ ...window });
      },
    },
    tabs: {
      create: options.createTab,
      onActivated: events.tabActivated,
      onCreated: events.tabCreated,
      onRemoved: events.tabRemoved,
      onUpdated: events.tabUpdated,
      query(queryInfo, callback) {
        const finishQuery = () => {
          queryCount += 1;
          if (options.queryHook) {
            const result = options.queryHook(queryCount, queryInfo, { tabMap, windowMap });
            if (result !== undefined) {
              callback(result.map(hydrateTab));
              return;
            }
          }
          callback(
            [...tabMap.values()]
              .filter((tab) => (
                queryInfo.windowId === undefined || tab.windowId === queryInfo.windowId
              ))
              .filter((tab) => queryInfo.active === undefined || tab.active === queryInfo.active)
              .map((tab) => ({ ...tab })),
          );
        };
        if (options.deferWindowQueries && queryInfo.windowId !== undefined) {
          pendingQueries.push(finishQuery);
        } else {
          finishQuery();
        }
      },
      get(tabId, callback) {
        const tab = tabMap.get(tabId);
        if (!tab) {
          failCallback("Tab not found", callback, undefined);
          return;
        }
        callback({ ...tab });
      },
      group(groupOptions, callback) {
        const ids = Array.isArray(groupOptions.tabIds) ? groupOptions.tabIds : [groupOptions.tabIds];
        calls.groups.push({ tabIds: [...ids], groupId: groupOptions.groupId });
        for (const id of ids) {
          const tab = tabMap.get(id);
          if (tab) tab.groupId = groupOptions.groupId;
        }
        if (callback) callback(groupOptions.groupId ?? 1);
      },
      move(tabIds, moveProperties, callback) {
        moveCount += 1;
        const ids = Array.isArray(tabIds) ? tabIds : [tabIds];
        calls.moves.push({ tabIds: [...ids], ...moveProperties });
        const moveError = options.moveHook?.(moveCount, ids, moveProperties);
        if (moveError) {
          failCallback(moveError, callback || (() => {}), undefined);
          return;
        }
        const finishMove = () => {
          const targetTabs = [...tabMap.values()]
            .filter((tab) => tab.windowId === moveProperties.windowId && !ids.includes(tab.id))
            .sort((left, right) => left.index - right.index);
          const insertionIndex = moveProperties.index === -1
            ? targetTabs.length
            : Math.max(0, Math.min(moveProperties.index, targetTabs.length));
          targetTabs.forEach((tab, index) => {
            tab.index = index < insertionIndex ? index : index + ids.length;
          });
          const moved = ids.map((id, offset) => {
            const tab = tabMap.get(id);
            if (tab) {
              tab.windowId = moveProperties.windowId;
              tab.index = insertionIndex + offset;
            }
            return tab ? { ...tab } : undefined;
          }).filter(Boolean);
          if (callback) callback(Array.isArray(tabIds) ? moved : moved[0]);
        };
        if (options.deferMoves) {
          pendingMoves.push(finishMove);
        } else {
          finishMove();
        }
      },
      update(tabId, updateProperties, callback) {
        const tab = tabMap.get(tabId);
        if (!tab) {
          failCallback("Tab not found", callback || (() => {}), undefined);
          return;
        }
        if (updateProperties.active) {
          for (const otherTab of tabMap.values()) {
            if (otherTab.windowId === tab.windowId) otherTab.active = false;
          }
        }
        Object.assign(tab, updateProperties);
        calls.tabUpdates.push({ tabId, ...updateProperties });
        if (callback) callback({ ...tab });
      },
    },
  };

  vm.runInNewContext(workerCode, {
    chrome,
    console,
    setTimeout(callback, delay) {
      calls.timeouts.push(delay);
      callback();
    },
    URL,
  });

  function flushInitialStorageGet() {
    const pending = pendingStorageGets.shift();
    if (!pending) return;
    const result = {};
    for (const [key, fallback] of Object.entries(pending.defaults)) {
      result[key] = Object.hasOwn(stored, key) ? stored[key] : fallback;
    }
    pending.callback(result);
  }

  function flushNextMove() {
    pendingMoves.shift()?.();
  }

  function flushNextQuery() {
    pendingQueries.shift()?.();
  }

  return {
    calls,
    events,
    flushInitialStorageGet,
    flushNextMove,
    flushNextQuery,
    pendingMoves,
    pendingQueries,
    sessionStored,
    stored,
    tabMap,
    windowMap,
  };
}

function normalWindow(id, incognito = false) {
  return { id, focused: true, incognito, type: "normal" };
}

function popupWindow(id, incognito = false) {
  return { id, focused: true, incognito, type: "popup" };
}

test("loads initial settings and displays the action badge", () => {
  const enabled = createHarness();
  assert.equal(enabled.calls.badges.at(-1), "ON");

  const disabled = createHarness({ storage: { enabled: false } });
  assert.equal(disabled.calls.badges.at(-1), "OFF");

  const staleError = createHarness({
    storage: {
      lastDiagnostic: {
        status: "error",
        timestamp: "2000-01-01T00:00:00.000Z",
      },
    },
  });
  assert.equal(staleError.calls.badges.at(-1), "ON");

  const recentTimestamp = new Date().toISOString();
  const recentError = createHarness({
    storage: {
      lastDiagnostic: {
        status: "error",
        timestamp: recentTimestamp,
      },
    },
  });
  assert.equal(recentError.calls.badges.at(-1), "ERR");
  assert.deepEqual(recentError.calls.alarms.at(-1), {
    name: "diagnosticBadgeExpiry",
    when: Date.parse(recentTimestamp) + 5 * 60 * 1000,
  });
});


test("clears an expired diagnostic badge when its alarm fires", () => {
  const harness = createHarness({
    storage: {
      lastDiagnostic: {
        status: "warning",
        timestamp: new Date().toISOString(),
      },
    },
  });
  assert.equal(harness.calls.badges.at(-1), "WARN");

  harness.stored.lastDiagnostic.timestamp = "2000-01-01T00:00:00.000Z";
  harness.events.alarm.emit({
    name: "diagnosticBadgeExpiry",
    scheduledTime: Date.now(),
  });

  assert.equal(harness.calls.badges.at(-1), "ON");
  assert.equal(harness.calls.clearedAlarms.at(-1), "diagnosticBadgeExpiry");
});

test("waits for stored settings before handling a newly created popup", () => {
  const harness = createHarness({
    deferInitialStorageGet: true,
    storage: { enabled: true },
    windows: [normalWindow(10), popupWindow(20)],
    tabs: [{ id: 200, windowId: 20, index: 0, active: true }],
  });

  harness.events.windowCreated.emit(popupWindow(20));
  assert.equal(harness.calls.moves.length, 0);
  harness.events.storageChanged.emit(
    { enabled: { oldValue: true, newValue: false } },
    "local",
  );
  harness.flushInitialStorageGet();
  assert.equal(harness.calls.moves.length, 0);
  assert.equal(harness.calls.badges.at(-1), "OFF");
});

test("fails closed after repeated local settings read failures", () => {
  const harness = createHarness({
    failInitialStorageGets: 4,
    storage: { enabled: true },
    windows: [normalWindow(10), popupWindow(20)],
    tabs: [{ id: 200, windowId: 20, index: 0, active: true }],
  });

  assert.deepEqual(harness.calls.timeouts.slice(0, 3), [100, 200, 300]);
  assert.equal(harness.calls.badges.at(-1), "OFF");

  harness.events.windowCreated.emit(popupWindow(20));
  assert.equal(harness.calls.moves.length, 0);
});

test("windows.onCreated: remembers a normal window as the latest window", () => {
  const harness = createHarness();
  const window = normalWindow(10);
  harness.windowMap.set(10, window);
  harness.events.windowCreated.emit(window);
  assert.equal(harness.stored.lastRegularWindowId, 10);
  const writesAfterFirstObservation = harness.calls.storageSets.length;

  harness.events.windowCreated.emit(window);
  assert.equal(harness.calls.storageSets.length, writesAfterFirstObservation);
});

test("leaves a target=_blank normal tab at the browser-selected position", () => {
  const harness = createHarness({
    windows: [normalWindow(10)],
    tabs: [
      { id: 100, windowId: 10, index: 0, active: true },
      {
        id: 101,
        windowId: 10,
        index: 1,
        openerTabId: 100,
        url: "https://linked.example/",
      },
    ],
  });

  harness.events.tabCreated.emit({ ...harness.tabMap.get(101) });
  assert.equal(harness.calls.moves.length, 0);
});

test("the end-tab command bypasses adjacent placement only for the tab it creates", async () => {
  const current = { id: 100, windowId: 10, index: 0, active: true };
  let finishCreation;
  const harness = createHarness({
    windows: [normalWindow(10)],
    tabs: [current, { id: 101, windowId: 10, index: 1 }],
    createTab(properties) {
      assert.equal(properties.active, true);
      assert.equal(properties.windowId, current.windowId);
      assert.ok(properties.index >= 2);
      return new Promise((resolve) => { finishCreation = resolve; });
    },
  });

  harness.events.command.emit("open-tab-at-end", current);
  const ordinary = { id: 102, windowId: 10, index: 2, url: "chrome://newtab/" };
  const shortcut = { ...ordinary, id: 103, index: 3 };
  for (const tab of [ordinary, shortcut]) {
    harness.tabMap.set(tab.id, tab);
    harness.events.tabCreated.emit({ ...tab });
  }
  finishCreation(shortcut);
  await new Promise(setImmediate);

  assert.deepEqual(harness.calls.moves, [{ tabIds: [102], windowId: 10, index: 1 }]);
  assert.equal(harness.tabMap.get(shortcut.id).index, 3);
});

test("recognizes the shortcut tab when its New Tab URL arrives later", async () => {
  const current = { id: 100, windowId: 10, index: 0, active: true };
  const shortcut = { id: 102, windowId: 10, index: 2 };
  const harness = createHarness({
    windows: [normalWindow(10)],
    tabs: [current, { id: 101, windowId: 10, index: 1 }, shortcut],
    createTab: async () => shortcut,
  });
  harness.events.command.emit("open-tab-at-end", current);
  await new Promise(setImmediate);
  harness.events.tabCreated.emit(shortcut);
  harness.events.tabUpdated.emit(shortcut.id, { url: "edge://newtab/" }, shortcut);
  assert.deepEqual(harness.calls.moves, []);
});

test("the end-tab command follows the switch before and after startup", () => {
  for (const initiallyEnabled of [false, true]) {
    const createdIn = [];
    const harness = createHarness({
      deferInitialStorageGet: true,
      storage: { enabled: initiallyEnabled },
      createTab: async ({ windowId }) => {
        createdIn.push(windowId);
        return { id: createdIn.length, windowId };
      },
    });
    const press = (windowId) => harness.events.command.emit("open-tab-at-end", { windowId });
    press(10);
    press(20);
    assert.deepEqual(createdIn, []);
    harness.flushInitialStorageGet();
    const expected = initiallyEnabled ? [10, 20] : [];
    assert.deepEqual(createdIn, expected);
    harness.events.storageChanged.emit({ enabled: { newValue: false } }, "local");
    press(10);
    assert.deepEqual(createdIn, expected);
    harness.events.storageChanged.emit({ enabled: { newValue: true } }, "local");
    press(20);
    assert.deepEqual(createdIn, [...expected, 20]);
  }
});

test("turning off cancels a startup shortcut even if switched back on", () => {
  const harness = createHarness({
    deferInitialStorageGet: true,
    createTab: () => assert.fail("cancelled shortcut opened a tab"),
  });
  harness.events.command.emit("open-tab-at-end", { windowId: 10 });
  harness.events.storageChanged.emit({ enabled: { newValue: false } }, "local");
  harness.events.command.emit("open-tab-at-end", { windowId: 10 });
  harness.events.storageChanged.emit({ enabled: { newValue: true } }, "local");
  harness.flushInitialStorageGet();
});

test("a shortcut never delays another window's New Tab placement", async () => {
  // Also exercise onCommand without a tab, when only the focused window is known.
  for (const commandTab of [{ windowId: 10 }, undefined]) {
    let finishCreation;
    const reference = { id: 200, windowId: 20, index: 0, active: true };
    const harness = createHarness({
      windows: [normalWindow(10), { ...normalWindow(20), focused: false }],
      tabs: [reference, { id: 201, windowId: 20, index: 1 }],
      createTab({ windowId }) {
        assert.equal(windowId, 10);
        return new Promise((resolve) => { finishCreation = resolve; });
      },
    });
    harness.events.command.emit("open-tab-at-end", commandTab);
    const ordinary = { id: 202, windowId: 20, index: 2, url: "chrome://newtab/" };
    harness.tabMap.set(ordinary.id, ordinary);
    harness.events.tabCreated.emit(ordinary);
    assert.deepEqual(harness.calls.moves, [{ tabIds: [202], windowId: 20, index: 1 }]);
    harness.tabMap.delete(reference.id);
    harness.events.tabRemoved.emit(reference.id);
    finishCreation({ id: 101, windowId: 10 });
    await new Promise(setImmediate);
    assert.ok(harness.tabMap.get(202).index < harness.tabMap.get(201).index);
  }
});

test("places a newly created New Tab page directly after the current tab", () => {
  const harness = createHarness({
    windows: [normalWindow(10)],
    tabs: [
      { id: 99, windowId: 10, index: 0 },
      { id: 100, windowId: 10, index: 1, active: true },
      { id: 101, windowId: 10, index: 2 },
    ],
  });
  harness.tabMap.get(100).active = false;
  const newTab = {
    id: 102,
    windowId: 10,
    index: 3,
    active: true,
    url: "chrome://newtab/",
  };
  harness.tabMap.set(102, newTab);

  harness.events.tabCreated.emit({ ...newTab });

  assert.deepEqual(harness.calls.moves.at(-1), { tabIds: [102], windowId: 10, index: 2 });
  assert.equal(harness.tabMap.get(102).index, 2);
});

test("leaves New Tab pages at the browser default position when placement is off", () => {
  const harness = createHarness({
    storage: { newTabNextToCurrent: false },
    windows: [normalWindow(10)],
    tabs: [
      { id: 100, windowId: 10, index: 0, active: true },
      { id: 101, windowId: 10, index: 1 },
    ],
  });
  harness.tabMap.get(100).active = false;
  const newTab = {
    id: 102,
    windowId: 10,
    index: 2,
    active: true,
    url: "chrome://newtab/",
  };
  harness.tabMap.set(102, newTab);

  harness.events.tabCreated.emit({ ...newTab });

  assert.equal(harness.calls.moves.length, 0);
});

test("applies New Tab placement immediately when its setting is enabled", () => {
  const harness = createHarness({
    storage: { newTabNextToCurrent: false },
    windows: [normalWindow(10)],
    tabs: [
      { id: 100, windowId: 10, index: 0, active: true },
      { id: 101, windowId: 10, index: 1 },
    ],
  });
  harness.events.storageChanged.emit(
    { newTabNextToCurrent: { oldValue: false, newValue: true } },
    "local",
  );
  harness.tabMap.get(100).active = false;
  const newTab = {
    id: 102,
    windowId: 10,
    index: 2,
    active: true,
    url: "chrome://newtab/",
  };
  harness.tabMap.set(102, newTab);

  harness.events.tabCreated.emit({ ...newTab });

  assert.deepEqual(harness.calls.moves.at(-1), { tabIds: [102], windowId: 10, index: 1 });
});

test("uses the previous active tab when New Tab activation precedes creation", () => {
  const harness = createHarness({
    windows: [normalWindow(10)],
    tabs: [
      { id: 100, windowId: 10, index: 0, active: true },
      { id: 101, windowId: 10, index: 1 },
    ],
  });
  harness.tabMap.get(100).active = false;
  const newTab = {
    id: 102,
    windowId: 10,
    index: 2,
    active: true,
    url: "chrome://newtab/",
  };
  harness.tabMap.set(102, newTab);
  harness.events.tabActivated.emit({ tabId: 102, windowId: 10 });

  harness.events.tabCreated.emit({ ...newTab });

  assert.deepEqual(harness.calls.moves.at(-1), { tabIds: [102], windowId: 10, index: 1 });
});

test("does not reposition an ordinary background tab", () => {
  const harness = createHarness({
    windows: [normalWindow(10)],
    tabs: [
      { id: 100, windowId: 10, index: 0 },
      { id: 101, windowId: 10, index: 1, active: true },
    ],
  });
  const newTab = {
    id: 102,
    windowId: 10,
    index: 2,
    active: false,
    openerTabId: 100,
    url: "https://linked.example/",
  };
  harness.tabMap.set(102, newTab);

  harness.events.tabCreated.emit({ ...newTab });

  assert.equal(harness.calls.moves.length, 0);
});

test("adds a New Tab page to the current tab group and keeps it adjacent", () => {
  const harness = createHarness({
    windows: [normalWindow(10)],
    tabs: [
      { id: 100, windowId: 10, index: 0, active: true, groupId: 7 },
      { id: 101, windowId: 10, index: 1, groupId: 7 },
      { id: 102, windowId: 10, index: 2, groupId: -1 },
    ],
  });
  harness.tabMap.get(100).active = false;
  const newTab = {
    id: 103,
    windowId: 10,
    index: 3,
    active: true,
    groupId: -1,
    url: "chrome://newtab/",
  };
  harness.tabMap.set(103, newTab);

  harness.events.tabCreated.emit({ ...newTab });

  assert.deepEqual(harness.calls.moves.slice(-2).map(({ index }) => index), [2, 1]);
  assert.deepEqual(harness.calls.groups.at(-1), { tabIds: [103], groupId: 7 });
  assert.equal(harness.tabMap.get(103).index, 1);
});

test("places a New Tab page after the pinned tab area", () => {
  const harness = createHarness({
    windows: [normalWindow(10)],
    tabs: [
      { id: 100, windowId: 10, index: 0, active: true, pinned: true },
      { id: 101, windowId: 10, index: 1, pinned: true },
      { id: 102, windowId: 10, index: 2, pinned: false },
    ],
  });
  harness.tabMap.get(100).active = false;
  const newTab = {
    id: 103,
    windowId: 10,
    index: 3,
    active: true,
    pinned: false,
    url: "edge://newtab/",
  };
  harness.tabMap.set(103, newTab);

  harness.events.tabCreated.emit({ ...newTab });

  assert.deepEqual(harness.calls.moves.at(-1), { tabIds: [103], windowId: 10, index: 2 });
});

test("waits for a missing URL before identifying a New Tab page", () => {
  const harness = createHarness({
    windows: [normalWindow(10)],
    tabs: [
      { id: 100, windowId: 10, index: 0, active: true },
      { id: 101, windowId: 10, index: 1 },
    ],
  });
  harness.tabMap.get(100).active = false;
  const newTab = { id: 102, windowId: 10, index: 2, active: true, url: undefined };
  harness.tabMap.set(102, newTab);

  harness.events.tabCreated.emit({ ...newTab });
  assert.equal(harness.calls.moves.length, 0);

  newTab.pendingUrl = "chrome://newtab/";
  harness.events.tabUpdated.emit(102, { url: "chrome://newtab/" }, { ...newTab });
  assert.deepEqual(harness.calls.moves.at(-1), { tabIds: [102], windowId: 10, index: 1 });
});

test("waits for an about:blank New Tab page to reveal its final URL", () => {
  const harness = createHarness({
    windows: [normalWindow(10)],
    tabs: [
      { id: 100, windowId: 10, index: 0, active: true },
      { id: 101, windowId: 10, index: 1 },
    ],
  });
  harness.tabMap.get(100).active = false;
  const newTab = {
    id: 102,
    windowId: 10,
    index: 2,
    active: true,
    url: "about:blank",
  };
  harness.tabMap.set(102, newTab);

  harness.events.tabCreated.emit({ ...newTab });
  assert.equal(harness.calls.moves.length, 0);

  newTab.pendingUrl = "chrome://newtab/";
  harness.events.tabUpdated.emit(102, { url: "chrome://newtab/" }, { ...newTab });

  assert.deepEqual(harness.calls.moves.at(-1), { tabIds: [102], windowId: 10, index: 1 });
});

test("keeps waiting when a missing New Tab URL first becomes about:blank", () => {
  const harness = createHarness({
    windows: [normalWindow(10)],
    tabs: [
      { id: 100, windowId: 10, index: 0, active: true },
      { id: 101, windowId: 10, index: 1 },
    ],
  });
  harness.tabMap.get(100).active = false;
  const newTab = { id: 102, windowId: 10, index: 2, active: true, url: undefined };
  harness.tabMap.set(102, newTab);

  harness.events.tabCreated.emit({ ...newTab });
  newTab.url = "about:blank";
  harness.events.tabUpdated.emit(102, { url: "about:blank" }, { ...newTab });
  assert.equal(harness.calls.moves.length, 0);

  newTab.pendingUrl = "edge://newtab/";
  harness.events.tabUpdated.emit(102, { url: "edge://newtab/" }, { ...newTab });

  assert.deepEqual(harness.calls.moves.at(-1), { tabIds: [102], windowId: 10, index: 1 });
});

test("does not move a delayed ordinary web tab", () => {
  const harness = createHarness({
    windows: [normalWindow(10)],
    tabs: [{ id: 100, windowId: 10, index: 0, active: true }],
  });
  const newTab = { id: 101, windowId: 10, index: 1, active: false, url: undefined };
  harness.tabMap.set(101, newTab);

  harness.events.tabCreated.emit({ ...newTab });
  newTab.pendingUrl = "https://linked.example/";
  harness.events.tabUpdated.emit(101, { url: "https://linked.example/" }, { ...newTab });

  assert.equal(harness.calls.moves.length, 0);
});

test("windows.onCreated: moves a popup with an opener into the opener window", () => {
  const harness = createHarness({
    windows: [normalWindow(10), popupWindow(20)],
    tabs: [
      { id: 99, windowId: 10, index: 0, active: false },
      { id: 100, windowId: 10, index: 2, active: true },
      { id: 101, windowId: 10, index: 4, active: false },
      { id: 200, windowId: 20, index: 0, active: true, openerTabId: 100 },
    ],
  });

  harness.events.windowCreated.emit(popupWindow(20));
  assert.deepEqual(harness.calls.moves, [
    { tabIds: [200], windowId: 10, index: 3 },
  ]);
  assert.deepEqual(harness.calls.tabUpdates, [
    { tabId: 200, active: true },
  ]);
  assert.deepEqual(harness.calls.windowUpdates, [
    { windowId: 10, focused: true },
  ]);
});

test("places a popup directly after its opener before an existing normal child tab", () => {
  const harness = createHarness({
    windows: [normalWindow(10), popupWindow(20)],
    tabs: [
      { id: 99, windowId: 10, index: 0 },
      { id: 100, windowId: 10, index: 1, active: true },
      { id: 101, windowId: 10, index: 2, openerTabId: 100 },
      { id: 102, windowId: 10, index: 3 },
      { id: 200, windowId: 20, index: 0, active: true, openerTabId: 100 },
    ],
  });

  harness.events.windowCreated.emit(popupWindow(20));
  assert.equal(harness.calls.moves[0].index, 2);
  assert.equal(harness.sessionStored.movedPopupTabsByOpener["100"][0], 200);
});

test("restores consecutive popup placement state after a service worker restart", () => {
  const harness = createHarness({
    sessionStorage: { movedPopupTabsByOpener: { 100: [200] } },
    windows: [normalWindow(10), popupWindow(21)],
    tabs: [
      { id: 100, windowId: 10, index: 0, active: true },
      { id: 200, windowId: 10, index: 1, openerTabId: 100 },
      { id: 101, windowId: 10, index: 2, openerTabId: 100 },
      { id: 201, windowId: 21, index: 0, active: true, openerTabId: 100 },
    ],
  });

  harness.events.windowCreated.emit(popupWindow(21));
  assert.equal(harness.calls.moves[0].index, 2);
});

test("removes closed tabs from the session popup-placement state", () => {
  const harness = createHarness({
    sessionStorage: { movedPopupTabsByOpener: { 100: [200] } },
    windows: [normalWindow(10)],
    tabs: [
      { id: 100, windowId: 10, index: 0, active: true },
      { id: 200, windowId: 10, index: 1, openerTabId: 100 },
    ],
  });

  harness.events.tabRemoved.emit(200);
  assert.deepEqual(Object.keys(harness.sessionStored.movedPopupTabsByOpener), []);
});

test("retries when popup tab attachment is delayed", () => {
  let popupQueryCount = 0;
  const harness = createHarness({
    windows: [normalWindow(10), popupWindow(20)],
    tabs: [{ id: 100, windowId: 10 }],
    queryHook(_count, queryInfo) {
      if (queryInfo.windowId !== 20) return undefined;
      popupQueryCount += 1;
      if (popupQueryCount === 1) return [];
      return [{ id: 200, windowId: 20, index: 0, active: true, openerTabId: 100 }];
    },
  });

  harness.events.windowCreated.emit(popupWindow(20));
  assert.equal(harness.calls.timeouts.length, 1);
  assert.equal(harness.calls.moves[0].windowId, 10);
});

test("uses the remembered normal window when no opener is available", () => {
  const harness = createHarness({
    storage: { lastRegularWindowId: 11 },
    windows: [normalWindow(11), popupWindow(20)],
    tabs: [{ id: 200, windowId: 20 }],
  });

  harness.events.windowCreated.emit(popupWindow(20));
  assert.equal(harness.calls.moves[0].windowId, 11);
});

test("keeps a popup when no compatible normal window exists", () => {
  const harness = createHarness({
    windows: [popupWindow(20)],
    tabs: [{ id: 200, windowId: 20, index: 0, active: true }],
  });

  harness.events.windowCreated.emit(popupWindow(20));
  assert.equal(harness.calls.moves.length, 0);
  assert.equal(harness.stored.lastDiagnostic.status, "error");
});

test("discards an invalid remembered window ID and uses an open normal window", () => {
  const harness = createHarness({
    storage: { lastRegularWindowId: 999 },
    windows: [normalWindow(12), popupWindow(20)],
    tabs: [{ id: 200, windowId: 20 }],
  });

  harness.events.windowCreated.emit(popupWindow(20));
  assert.equal(harness.stored.lastRegularWindowId, 12);
  assert.equal(harness.calls.moves[0].windowId, 12);
});

test("keeps separate fallback targets for regular and incognito windows", () => {
  const harness = createHarness({
    storage: { lastRegularWindowId: 10, lastIncognitoWindowId: 30 },
    windows: [normalWindow(10), normalWindow(30, true), popupWindow(40, true)],
    tabs: [{ id: 400, windowId: 40 }],
  });

  harness.events.windowCreated.emit(popupWindow(40, true));
  assert.equal(harness.calls.moves[0].windowId, 30);
});

test("focus and tab activation events update the latest normal window", () => {
  const harness = createHarness({
    windows: [normalWindow(10), normalWindow(11)],
  });

  harness.events.windowFocusChanged.emit(10);
  assert.equal(harness.stored.lastRegularWindowId, 10);

  harness.events.tabActivated.emit({ tabId: 101, windowId: 11 });
  assert.equal(harness.stored.lastRegularWindowId, 11);

  harness.events.windowFocusChanged.emit(-1);
  assert.equal(harness.stored.lastRegularWindowId, 11);
});

test("windows.onRemoved: clears the remembered window when it is removed", () => {
  const harness = createHarness({ windows: [normalWindow(10)] });
  harness.events.windowCreated.emit(normalWindow(10));
  harness.events.windowRemoved.emit(10);
  assert.equal(harness.stored.lastRegularWindowId, null);
});

test("runtime installation and startup events reload stored settings", () => {
  const harness = createHarness();
  harness.stored.enabled = false;
  harness.events.installed.emit();
  assert.equal(harness.calls.badges.at(-1), "OFF");

  harness.stored.enabled = true;
  harness.events.startup.emit();
  assert.equal(harness.calls.badges.at(-1), "ON");
});

test("storage.onChanged: immediately applies external enabled-state changes", () => {
  const harness = createHarness({
    windows: [normalWindow(10), popupWindow(20)],
    tabs: [{ id: 200, windowId: 20 }],
  });

  harness.events.storageChanged.emit(
    { enabled: { oldValue: true, newValue: false } },
    "local",
  );
  assert.equal(harness.calls.badges.at(-1), "OFF");
  harness.events.windowCreated.emit(popupWindow(20));
  assert.equal(harness.calls.moves.length, 0);
});

test("turning the extension off cancels popup work already waiting on a query", () => {
  const harness = createHarness({
    deferWindowQueries: true,
    windows: [normalWindow(10), popupWindow(20)],
    tabs: [
      { id: 100, windowId: 10, index: 0, active: true },
      { id: 200, windowId: 20, index: 0, active: true, openerTabId: 100 },
    ],
  });

  harness.events.windowCreated.emit(popupWindow(20));
  assert.equal(harness.pendingQueries.length, 1);

  harness.events.storageChanged.emit(
    { enabled: { oldValue: true, newValue: false } },
    "local",
  );
  harness.events.storageChanged.emit(
    { enabled: { oldValue: false, newValue: true } },
    "local",
  );
  harness.flushNextQuery();

  assert.equal(harness.calls.moves.length, 0);
});

test("keeps popups whose domains or subdomains match an exclusion", () => {
  const harness = createHarness({
    storage: { excludedUrls: ["example.com"] },
    windows: [normalWindow(10), popupWindow(20)],
    tabs: [
      { id: 100, windowId: 10, index: 0, active: true },
      {
        id: 200,
        windowId: 20,
        index: 0,
        active: true,
        openerTabId: 100,
        url: "https://login.example.com/oauth",
      },
    ],
  });

  harness.events.windowCreated.emit(popupWindow(20));
  assert.equal(harness.calls.moves.length, 0);
});

test("matches URL prefixes only within the same origin", () => {
  const excluded = createHarness({
    storage: { excludedUrls: ["https://example.com/login"] },
    windows: [normalWindow(10), popupWindow(20)],
    tabs: [
      { id: 100, windowId: 10, index: 0, active: true },
      {
        id: 200,
        windowId: 20,
        index: 0,
        active: true,
        openerTabId: 100,
        url: "https://example.com/login/callback?code=1",
      },
    ],
  });
  excluded.events.windowCreated.emit(popupWindow(20));
  assert.equal(excluded.calls.moves.length, 0);

  const differentOrigin = createHarness({
    storage: { excludedUrls: ["https://example.com/login"] },
    windows: [normalWindow(10), popupWindow(20)],
    tabs: [
      { id: 100, windowId: 10, index: 0, active: true },
      {
        id: 200,
        windowId: 20,
        index: 0,
        active: true,
        openerTabId: 100,
        url: "https://example.com.evil.test/login",
      },
    ],
  });
  differentOrigin.events.windowCreated.emit(popupWindow(20));
  assert.equal(differentOrigin.calls.moves.length, 1);
});

test("matches protocol-independent page paths over both HTTP and HTTPS", () => {
  for (const [offset, protocol] of ["http", "https"].entries()) {
    const popupWindowId = 20 + offset;
    const harness = createHarness({
      storage: { excludedUrls: ["example.com/login"] },
      windows: [normalWindow(10), popupWindow(popupWindowId)],
      tabs: [
        { id: 100, windowId: 10, index: 0, active: true },
        {
          id: 200 + offset,
          windowId: popupWindowId,
          index: 0,
          active: true,
          openerTabId: 100,
          url: `${protocol}://example.com/login/callback`,
        },
      ],
    });

    harness.events.windowCreated.emit(popupWindow(popupWindowId));
    assert.equal(harness.calls.moves.length, 0, protocol);
  }
});

test("applies wildcard and pendingUrl exclusions", () => {
  const harness = createHarness({
    storage: { excludedUrls: ["*://*.example.net/*"] },
    windows: [normalWindow(10), popupWindow(20)],
    tabs: [
      { id: 100, windowId: 10, index: 0, active: true },
      {
        id: 200,
        windowId: 20,
        index: 0,
        active: true,
        openerTabId: 100,
        url: "about:blank",
        pendingUrl: "https://auth.example.net/sign-in",
      },
    ],
  });

  harness.events.windowCreated.emit(popupWindow(20));
  assert.equal(harness.calls.moves.length, 0);
  assert.equal(harness.calls.timeouts.length, 0);
});

test("wildcard exclusions ignore host case but preserve path case", () => {
  const matching = createHarness({
    storage: { excludedUrls: ["*://AUTH.example.net/Sign-In/*"] },
    windows: [normalWindow(10), popupWindow(20)],
    tabs: [
      { id: 100, windowId: 10, index: 0, active: true },
      {
        id: 200,
        windowId: 20,
        index: 0,
        active: true,
        openerTabId: 100,
        url: "https://auth.example.net/Sign-In/step",
      },
    ],
  });
  matching.events.windowCreated.emit(popupWindow(20));
  assert.equal(matching.calls.moves.length, 0);

  const differentPathCase = createHarness({
    storage: { excludedUrls: ["*://AUTH.example.net/Sign-In/*"] },
    windows: [normalWindow(10), popupWindow(20)],
    tabs: [
      { id: 100, windowId: 10, index: 0, active: true },
      {
        id: 200,
        windowId: 20,
        index: 0,
        active: true,
        openerTabId: 100,
        url: "https://auth.example.net/sign-in/step",
      },
    ],
  });
  differentPathCase.events.windowCreated.emit(popupWindow(20));
  assert.equal(differentPathCase.calls.moves.length, 1);
});

test("waits once for an about:blank popup URL before checking exclusions", () => {
  let popupQueryCount = 0;
  const harness = createHarness({
    storage: { excludedUrls: ["example.org"] },
    windows: [normalWindow(10), popupWindow(20)],
    tabs: [{ id: 100, windowId: 10, index: 0, active: true }],
    queryHook(_count, queryInfo) {
      if (queryInfo.windowId !== 20) return undefined;
      popupQueryCount += 1;
      return [{
        id: 200,
        windowId: 20,
        index: 0,
        active: true,
        openerTabId: 100,
        url: popupQueryCount === 1 ? "about:blank" : "https://example.org/ready",
      }];
    },
  });

  harness.events.windowCreated.emit(popupWindow(20));
  assert.equal(harness.calls.timeouts.length, 1);
  assert.equal(harness.calls.moves.length, 0);
});

test("immediately applies URL exclusions changed in storage", () => {
  const harness = createHarness({
    windows: [normalWindow(10), popupWindow(20)],
    tabs: [
      { id: 100, windowId: 10, index: 0, active: true },
      {
        id: 200,
        windowId: 20,
        index: 0,
        active: true,
        openerTabId: 100,
        url: "https://example.com/popup",
      },
    ],
  });

  harness.events.storageChanged.emit(
    { excludedUrls: { oldValue: [], newValue: ["example.com"] } },
    "local",
  );
  harness.events.windowCreated.emit(popupWindow(20));
  assert.equal(harness.calls.moves.length, 0);
});

test("keeps the entire popup when any popup tab matches an exclusion", () => {
  const harness = createHarness({
    storage: { excludedUrls: ["keep.example"] },
    windows: [normalWindow(10), popupWindow(20)],
    tabs: [
      { id: 100, windowId: 10, index: 0, active: true },
      { id: 200, windowId: 20, index: 0, active: true, openerTabId: 100, url: "https://move.example/" },
      { id: 201, windowId: 20, index: 1, active: false, openerTabId: 100, url: "https://keep.example/" },
    ],
  });

  harness.events.windowCreated.emit(popupWindow(20));
  assert.equal(harness.calls.moves.length, 0);
});

test("always keeps browser-extension and browser-internal popup pages", () => {
  const protectedUrls = [
    "chrome-extension://nngceckbapebfimnlniiiahkandclblb/popup/index.html",
    "extension://jbkfoedolllekgbhcbcoahefnbanhhlh/popup/index.html",
    "edge-extension://example/popup.html",
    "moz-extension://example/popup.html",
    "chrome://settings/",
    "chrome-search://local-ntp/local-ntp.html",
    "chrome-untrusted://new-tab-page/",
    "edge://settings/",
    "view-source:https://example.test/",
  ];

  for (const [offset, url] of protectedUrls.entries()) {
    const popupWindowId = 20 + offset;
    const harness = createHarness({
      windows: [normalWindow(10), popupWindow(popupWindowId)],
      tabs: [
        { id: 100, windowId: 10, index: 0, active: true },
        {
          id: 200 + offset,
          windowId: popupWindowId,
          index: 0,
          active: true,
          openerTabId: 100,
          url,
        },
      ],
    });

    harness.events.windowCreated.emit(popupWindow(popupWindowId));
    assert.equal(harness.calls.moves.length, 0, url);
  }
});

test("waits for an about:blank popup that navigates to a protected extension page", () => {
  let popupQueryCount = 0;
  const harness = createHarness({
    windows: [normalWindow(10), popupWindow(20)],
    tabs: [{ id: 100, windowId: 10, index: 0, active: true }],
    queryHook(_count, queryInfo) {
      if (queryInfo.windowId !== 20) return undefined;
      popupQueryCount += 1;
      return [{
        id: 200,
        windowId: 20,
        index: 0,
        active: true,
        openerTabId: 100,
        url: popupQueryCount === 1
          ? "about:blank"
          : "chrome-extension://nngceckbapebfimnlniiiahkandclblb/popup/index.html",
      }];
    },
  });

  harness.events.windowCreated.emit(popupWindow(20));
  assert.equal(harness.calls.timeouts.length, 1);
  assert.equal(harness.calls.moves.length, 0);
});

test("keeps polling a missing popup URL until a protected destination appears", () => {
  let popupQueryCount = 0;
  const harness = createHarness({
    windows: [normalWindow(10), popupWindow(20)],
    tabs: [{ id: 100, windowId: 10, index: 0, active: true }],
    queryHook(_count, queryInfo) {
      if (queryInfo.windowId !== 20) return undefined;
      popupQueryCount += 1;
      return [{
        id: 200,
        windowId: 20,
        index: 0,
        active: true,
        openerTabId: 100,
        url: popupQueryCount < 4 ? undefined : "chrome-extension://example/login.html",
      }];
    },
  });

  harness.events.windowCreated.emit(popupWindow(20));
  assert.equal(harness.calls.timeouts.length, 3);
  assert.equal(harness.calls.moves.length, 0);
});

test("moves an unresolved regular popup after the URL settle timeout", () => {
  const harness = createHarness({
    windows: [normalWindow(10), popupWindow(20)],
    tabs: [
      { id: 100, windowId: 10, index: 0, active: true },
      {
        id: 200,
        windowId: 20,
        index: 0,
        active: true,
        openerTabId: 100,
        url: undefined,
      },
    ],
  });

  harness.events.windowCreated.emit(popupWindow(20));
  assert.equal(harness.calls.timeouts.length, 20);
  assert.equal(harness.calls.moves.length, 1);
});

test("immediately keeps an unresolved popup opened by a protected extension tab", () => {
  const harness = createHarness({
    windows: [normalWindow(10), popupWindow(20)],
    tabs: [
      {
        id: 100,
        windowId: 10,
        index: 0,
        active: true,
        url: "chrome-extension://example/popup.html",
      },
      {
        id: 200,
        windowId: 20,
        index: 0,
        active: true,
        openerTabId: 100,
        url: "about:blank",
      },
    ],
  });

  harness.events.windowCreated.emit(popupWindow(20));
  assert.equal(harness.calls.timeouts.length, 0);
  assert.equal(harness.calls.moves.length, 0);
});

test("retries a temporary tabs.move failure and records success", () => {
  const harness = createHarness({
    windows: [normalWindow(10), popupWindow(20)],
    tabs: [
      { id: 100, windowId: 10 },
      { id: 200, windowId: 20, openerTabId: 100 },
    ],
    moveHook(attempt) {
      return attempt === 1
        ? "Tabs cannot be edited right now (user may be dragging a tab)."
        : undefined;
    },
  });

  harness.events.windowCreated.emit(popupWindow(20));
  assert.equal(harness.calls.moves.length, 2);
  assert.equal(harness.calls.timeouts.length, 1);
  assert.equal(harness.stored.lastDiagnostic.status, "success");
  assert.equal(harness.stored.lastDiagnostic.attempt, 2);
});

test("stops after four retries when a temporary tabs.move failure persists", () => {
  const harness = createHarness({
    windows: [normalWindow(10), popupWindow(20)],
    tabs: [
      { id: 100, windowId: 10 },
      { id: 200, windowId: 20, openerTabId: 100 },
    ],
    moveHook() {
      return "Tabs cannot be edited right now (user may be dragging a tab).";
    },
  });

  harness.events.windowCreated.emit(popupWindow(20));
  assert.equal(harness.calls.moves.length, 5);
  assert.equal(harness.calls.timeouts.length, 4);
  assert.equal(harness.stored.lastDiagnostic.status, "error");
  assert.equal(harness.stored.lastDiagnostic.attempt, 5);
});

test("records a permanent tabs.move failure without retrying", () => {
  const harness = createHarness({
    windows: [normalWindow(10), popupWindow(20)],
    tabs: [
      { id: 100, windowId: 10 },
      { id: 200, windowId: 20, openerTabId: 100 },
    ],
    moveHook() {
      return "Tabs can only be moved to and from normal windows.";
    },
  });

  harness.events.windowCreated.emit(popupWindow(20));
  assert.equal(harness.calls.moves.length, 1);
  assert.equal(harness.stored.lastDiagnostic.status, "error");
  assert.match(harness.stored.lastDiagnostic.message, /normal windows/);
  assert.equal(harness.calls.badges.at(-1), "ERR");
});

test("retries in another normal window when the target closes before the move", () => {
  const harness = createHarness({
    storage: { lastRegularWindowId: 11 },
    windows: [normalWindow(10), normalWindow(11), popupWindow(20)],
    tabs: [
      { id: 100, windowId: 10, index: 0, active: true },
      { id: 110, windowId: 11, index: 0, active: true },
      { id: 200, windowId: 20, index: 0, active: true, openerTabId: 100 },
    ],
    moveHook(attempt) {
      return attempt === 1 ? "No window with id: 10." : undefined;
    },
  });

  harness.events.windowCreated.emit(popupWindow(20));
  assert.deepEqual(
    harness.calls.moves.map(({ windowId }) => windowId),
    [10, 11],
  );
  assert.equal(harness.stored.lastDiagnostic.status, "success");
});

test("preserves creation order for consecutive popups from the same opener", () => {
  const harness = createHarness({
    deferMoves: true,
    windows: [normalWindow(10), popupWindow(20), popupWindow(21)],
    tabs: [
      { id: 100, windowId: 10, index: 0, active: true },
      { id: 200, windowId: 20, index: 0, active: true, openerTabId: 100 },
      { id: 201, windowId: 21, index: 0, active: true, openerTabId: 100 },
    ],
  });

  harness.events.windowCreated.emit(popupWindow(20));
  harness.events.windowCreated.emit(popupWindow(21));
  assert.equal(harness.calls.moves.length, 1);
  harness.flushNextMove();
  assert.equal(harness.calls.moves.length, 2);
  harness.flushNextMove();
  assert.deepEqual(
    harness.calls.moves.map(({ tabIds, index }) => ({ tabIds, index })),
    [
      { tabIds: [200], index: 1 },
      { tabIds: [201], index: 2 },
    ],
  );
});

test("places each consecutive popup beside its opener when configured", () => {
  const harness = createHarness({
    deferMoves: true,
    storage: { popupPlacement: "besideCurrent" },
    windows: [normalWindow(10), popupWindow(20), popupWindow(21)],
    tabs: [
      { id: 100, windowId: 10, index: 0, active: true },
      { id: 200, windowId: 20, index: 0, active: true, openerTabId: 100 },
      { id: 201, windowId: 21, index: 0, active: true, openerTabId: 100 },
    ],
  });

  harness.events.windowCreated.emit(popupWindow(20));
  harness.events.windowCreated.emit(popupWindow(21));
  harness.flushNextMove();
  harness.flushNextMove();

  assert.deepEqual(
    harness.calls.moves.map(({ tabIds, index }) => ({ tabIds, index })),
    [
      { tabIds: [200], index: 1 },
      { tabIds: [201], index: 1 },
    ],
  );
  assert.equal(harness.tabMap.get(201).index, 1);
  assert.equal(harness.tabMap.get(200).index, 2);
});

test("applies Popup tab position changes immediately", () => {
  const harness = createHarness({
    deferMoves: true,
    windows: [normalWindow(10), popupWindow(20), popupWindow(21)],
    tabs: [
      { id: 100, windowId: 10, index: 0, active: true },
      { id: 200, windowId: 20, index: 0, active: true, openerTabId: 100 },
      { id: 201, windowId: 21, index: 0, active: true, openerTabId: 100 },
    ],
  });

  harness.events.windowCreated.emit(popupWindow(20));
  harness.flushNextMove();
  harness.events.storageChanged.emit(
    { popupPlacement: { oldValue: "openingOrder", newValue: "besideCurrent" } },
    "local",
  );
  harness.events.windowCreated.emit(popupWindow(21));
  harness.flushNextMove();

  assert.deepEqual(
    harness.calls.moves.map(({ tabIds, index }) => ({ tabIds, index })),
    [
      { tabIds: [200], index: 1 },
      { tabIds: [201], index: 1 },
    ],
  );
});

test("reactivates the originally active tab when moving multiple popup tabs", () => {
  const harness = createHarness({
    windows: [normalWindow(10), popupWindow(20)],
    tabs: [
      { id: 100, windowId: 10, index: 0, active: true },
      { id: 200, windowId: 20, index: 0, active: false, openerTabId: 100 },
      { id: 201, windowId: 20, index: 1, active: true, openerTabId: 100 },
      { id: 202, windowId: 20, index: 2, active: false, openerTabId: 100 },
    ],
  });

  harness.events.windowCreated.emit(popupWindow(20));
  assert.deepEqual(harness.calls.moves[0].tabIds, [200, 201, 202]);
  assert.deepEqual(harness.calls.tabUpdates, [{ tabId: 201, active: true }]);
});

test("sorts multiple popup tabs by their existing tab-strip index", () => {
  const harness = createHarness({
    windows: [normalWindow(10), popupWindow(20)],
    tabs: [{ id: 100, windowId: 10, index: 0, active: true }],
    queryHook(_count, queryInfo) {
      if (queryInfo.windowId !== 20) return undefined;
      return [
        { id: 202, windowId: 20, index: 2, openerTabId: 100 },
        { id: 200, windowId: 20, index: 0, active: true, openerTabId: 100 },
        { id: 201, windowId: 20, index: 1, openerTabId: 100 },
      ];
    },
  });

  harness.events.windowCreated.emit(popupWindow(20));
  assert.deepEqual(harness.calls.moves[0].tabIds, [200, 201, 202]);
});

test("moves outside the opener group before grouping and repositioning popup tabs", () => {
  const harness = createHarness({
    windows: [normalWindow(10), popupWindow(20)],
    tabs: [
      { id: 100, windowId: 10, index: 0, active: true, groupId: 7 },
      { id: 101, windowId: 10, index: 1, active: false, groupId: 7 },
      { id: 102, windowId: 10, index: 2, active: false, groupId: -1 },
      { id: 200, windowId: 20, index: 0, active: true, openerTabId: 100, groupId: -1 },
    ],
    moveHook(attempt, _ids, moveProperties) {
      return attempt === 1 && moveProperties.index === 1
        ? "Cannot insert an ungrouped tab inside a tab group."
        : undefined;
    },
  });

  harness.events.windowCreated.emit(popupWindow(20));
  assert.deepEqual(harness.calls.moves.map(({ index }) => index), [2, 1]);
  assert.deepEqual(harness.calls.groups, [{ tabIds: [200], groupId: 7 }]);
  assert.equal(harness.stored.lastDiagnostic.status, "success");
});

test("keeps a popup unpinned and places it after the pinned tab area", () => {
  const harness = createHarness({
    windows: [normalWindow(10), popupWindow(20)],
    tabs: [
      { id: 100, windowId: 10, index: 0, active: true, pinned: true },
      { id: 101, windowId: 10, index: 1, active: false, pinned: true },
      { id: 102, windowId: 10, index: 2, active: false, pinned: false },
      { id: 200, windowId: 20, index: 0, active: true, openerTabId: 100, pinned: false },
    ],
  });

  harness.events.windowCreated.emit(popupWindow(20));
  assert.deepEqual(harness.calls.moves.map(({ index }) => index), [2]);
  assert.equal(harness.tabMap.get(200).pinned, false);
  assert.deepEqual(harness.calls.tabUpdates, [{ tabId: 200, active: true }]);
});

test("preserves popup order after the pinned tab area", () => {
  const harness = createHarness({
    deferMoves: true,
    windows: [normalWindow(10), popupWindow(20), popupWindow(21)],
    tabs: [
      { id: 100, windowId: 10, index: 0, active: true, pinned: true },
      { id: 101, windowId: 10, index: 1, active: false, pinned: true },
      { id: 102, windowId: 10, index: 2, active: false, pinned: false },
      { id: 200, windowId: 20, index: 0, active: true, openerTabId: 100, pinned: false },
      { id: 201, windowId: 21, index: 0, active: true, openerTabId: 100, pinned: false },
    ],
  });

  harness.events.windowCreated.emit(popupWindow(20));
  harness.events.windowCreated.emit(popupWindow(21));
  harness.flushNextMove();
  harness.flushNextMove();

  assert.deepEqual(
    harness.calls.moves.map(({ tabIds, index }) => ({ tabIds, index })),
    [
      { tabIds: [200], index: 2 },
      { tabIds: [201], index: 3 },
    ],
  );
  assert.equal(harness.tabMap.get(200).pinned, false);
  assert.equal(harness.tabMap.get(201).pinned, false);
});

test("records an error when the popup tab never attaches", () => {
  const harness = createHarness({
    windows: [normalWindow(10), popupWindow(20)],
    queryHook(_count, queryInfo) {
      return queryInfo.windowId === 20 ? [] : undefined;
    },
  });

  harness.events.windowCreated.emit(popupWindow(20));
  assert.equal(harness.calls.timeouts.length, 12);
  assert.equal(harness.stored.lastDiagnostic.status, "error");
  assert.match(harness.stored.lastDiagnostic.message, /No movable tab was found/);
});

test("ignores legacy placement and focus settings", () => {
  const harness = createHarness({
    storage: {
      tabPlacement: "end",
      focusBehavior: "background",
    },
    windows: [normalWindow(10), popupWindow(20)],
    tabs: [
      { id: 100, windowId: 10, index: 1, active: false },
      { id: 101, windowId: 10, index: 4, active: true },
      { id: 200, windowId: 20, index: 0, active: true, openerTabId: 100 },
    ],
  });

  harness.events.windowCreated.emit(popupWindow(20));
  assert.equal(harness.calls.moves[0].index, 2);
  assert.deepEqual(harness.calls.tabUpdates, [{ tabId: 200, active: true }]);
  assert.deepEqual(harness.calls.windowUpdates, [{ windowId: 10, focused: true }]);
});
