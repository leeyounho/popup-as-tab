const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const popupCode = fs.readFileSync(
  path.join(__dirname, "..", "popup.js"),
  "utf8",
);
const popupHtml = fs.readFileSync(
  path.join(__dirname, "..", "popup.html"),
  "utf8",
);
const popupCss = fs.readFileSync(
  path.join(__dirname, "..", "popup.css"),
  "utf8",
);

function createElement() {
  const listeners = new Map();
  const attributes = new Map();
  const classes = new Set();
  return {
    checked: false,
    classList: {
      contains(name) {
        return classes.has(name);
      },
      toggle(name, force) {
        const enabled = force === undefined ? !classes.has(name) : force;
        if (enabled) classes.add(name);
        else classes.delete(name);
      },
    },
    dataset: {},
    disabled: false,
    hidden: false,
    textContent: "",
    value: "",
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    emit(type, event = {}) {
      listeners.get(type)?.(event);
    },
    getAttribute(name) {
      return attributes.get(name);
    },
    setAttribute(name, value) {
      attributes.set(name, String(value));
    },
  };
}

function createHarness({
  currentUrl,
  enabled = true,
  excludedUrls = [],
  popupPlacement = "openingOrder",
  newTabNextToCurrent = true,
}) {
  const elements = new Map([
    ["#enabled", createElement()],
    ["#popup-placement", createElement()],
    ["#new-tab-next-to-current", createElement()],
    ["#excluded-urls", createElement()],
    ["#add-current-page", createElement()],
    ["#add-current-label", createElement()],
    ["#rule-count", createElement()],
  ]);
  const storageSets = [];
  const timers = new Map();
  let nextTimerId = 1;
  const windowListeners = new Map();
  const popupWindow = {
    addEventListener(type, listener) {
      windowListeners.set(type, listener);
    },
    emit(type) {
      windowListeners.get(type)?.();
    },
  };

  function flushTimers() {
    const callbacks = [...timers.values()];
    timers.clear();
    for (const callback of callbacks) callback();
  }

  const chrome = {
    runtime: { lastError: undefined },
    storage: {
      local: {
        get(defaults, callback) {
          callback({
            ...defaults,
            enabled,
            excludedUrls,
            popupPlacement,
            newTabNextToCurrent,
          });
        },
        set(items, callback) {
          storageSets.push(items);
          callback?.();
        },
      },
    },
    tabs: {
      query(_queryInfo, callback) {
        callback(currentUrl ? [{ url: currentUrl }] : []);
      },
    },
  };

  vm.runInNewContext(popupCode, {
    URL,
    chrome,
    clearTimeout(timerId) {
      timers.delete(timerId);
    },
    setTimeout(callback) {
      const timerId = nextTimerId;
      nextTimerId += 1;
      timers.set(timerId, callback);
      return timerId;
    },
    window: popupWindow,
    document: {
      body: { classList: { toggle() {} } },
      querySelector(selector) {
        return elements.get(selector);
      },
    },
  });

  return { elements, flushTimers, popupWindow, storageSets, timers };
}

test("Exclude saves a protocol-independent path without query parameters or fragments", () => {
  const harness = createHarness({
    currentUrl: "https://example.com/login/callback?token=secret#result",
  });

  harness.elements.get("#add-current-page").emit("click");
  harness.popupWindow.emit("pagehide");
  assert.deepEqual(JSON.parse(JSON.stringify(harness.storageSets)), [{
    excludedUrls: ["example.com/login/callback"],
  }]);
  assert.equal(harness.elements.get("#add-current-label").textContent, "Excluded");
});

test("Exclude does not duplicate an existing rule", () => {
  const harness = createHarness({
    currentUrl: "https://example.com/login?step=2",
    excludedUrls: ["example.com/login"],
  });

  harness.elements.get("#add-current-page").emit("click");
  assert.equal(harness.storageSets.length, 0);
});

test("Exclude reports browser-extension pages as protected", () => {
  const harness = createHarness({
    currentUrl: "chrome-extension://example/popup/index.html",
  });

  harness.elements.get("#add-current-page").emit("click");
  assert.equal(harness.storageSets.length, 0);
});

test("editing URL rules batches writes and remains saved when the popup closes", () => {
  const harness = createHarness({
    currentUrl: "https://current.example/",
    excludedUrls: ["one.example"],
  });
  const input = harness.elements.get("#excluded-urls");

  assert.equal(harness.elements.get("#rule-count").textContent, "1");
  input.value = "one.example\ntwo.example";
  input.emit("input");

  assert.equal(harness.elements.get("#rule-count").textContent, "2");
  input.value = "one.example\ntwo.example\nthree.example";
  input.emit("input");
  assert.equal(harness.elements.get("#rule-count").textContent, "3");
  assert.equal(harness.storageSets.length, 0);

  harness.flushTimers();

  assert.deepEqual(
    JSON.parse(JSON.stringify(harness.storageSets)),
    [{ excludedUrls: ["one.example", "two.example", "three.example"] }],
  );

  harness.popupWindow.emit("pagehide");

  assert.deepEqual(
    JSON.parse(JSON.stringify(harness.storageSets)),
    [{ excludedUrls: ["one.example", "two.example", "three.example"] }],
  );
});

test("closing the popup flushes a pending URL rule edit once", () => {
  const harness = createHarness({
    currentUrl: "https://current.example/",
    excludedUrls: ["one.example"],
  });
  const input = harness.elements.get("#excluded-urls");
  input.value = "one.example\ntwo.example";
  input.emit("input");

  harness.popupWindow.emit("pagehide");
  harness.flushTimers();

  assert.deepEqual(
    JSON.parse(JSON.stringify(harness.storageSets)),
    [{ excludedUrls: ["one.example", "two.example"] }],
  );
});

test("the extension switch persists without changing visible text", () => {
  const harness = createHarness({ currentUrl: "https://example.com/" });
  const enabledInput = harness.elements.get("#enabled");
  enabledInput.checked = false;

  enabledInput.emit("change");

  assert.deepEqual(JSON.parse(JSON.stringify(harness.storageSets)), [{ enabled: false }]);
});

test("the Popup tab position select loads and persists the selected behavior", () => {
  const harness = createHarness({
    currentUrl: "https://example.com/",
    popupPlacement: "openingOrder",
  });
  const placementSelect = harness.elements.get("#popup-placement");

  assert.equal(placementSelect.value, "opening-order");
  assert.equal(placementSelect.disabled, false);

  placementSelect.value = "beside-current";
  placementSelect.emit("change");

  assert.deepEqual(
    JSON.parse(JSON.stringify(harness.storageSets)),
    [{ popupPlacement: "besideCurrent" }],
  );
  assert.equal(placementSelect.value, "beside-current");
  assert.equal(placementSelect.disabled, false);
});

test("the New Tab position select loads and persists the selected behavior", () => {
  const harness = createHarness({
    currentUrl: "https://example.com/",
    newTabNextToCurrent: false,
  });
  const placementSelect = harness.elements.get("#new-tab-next-to-current");

  assert.equal(placementSelect.value, "default");
  assert.equal(placementSelect.disabled, false);

  placementSelect.value = "beside";
  placementSelect.emit("change");

  assert.deepEqual(
    JSON.parse(JSON.stringify(harness.storageSets)),
    [{ newTabNextToCurrent: true }],
  );
  assert.equal(placementSelect.value, "beside");
  assert.equal(placementSelect.disabled, false);
});

test("the position selects are unavailable while the extension is off", () => {
  const harness = createHarness({
    currentUrl: "https://example.com/",
    enabled: false,
    newTabNextToCurrent: true,
  });
  const placementSelect = harness.elements.get("#new-tab-next-to-current");
  const popupPlacementSelect = harness.elements.get("#popup-placement");

  assert.equal(placementSelect.value, "beside");
  assert.equal(placementSelect.disabled, true);
  assert.equal(popupPlacementSelect.value, "opening-order");
  assert.equal(popupPlacementSelect.disabled, true);

  const enabledInput = harness.elements.get("#enabled");
  enabledInput.checked = true;
  enabledInput.emit("change");

  assert.equal(placementSelect.disabled, false);
  assert.equal(popupPlacementSelect.disabled, false);
});

test("the popup paints every root surface and keeps setting rows on one line", () => {
  assert.match(popupCss, /html,\s*body,\s*\.popup-shell\s*{[^}]*background-color:/s);
  assert.doesNotMatch(popupCss, /html\s*{[^}]*overflow:\s*hidden/s);
  assert.match(popupCss, /\.setting-row\s*{[^}]*min-height:\s*40px/s);
  assert.match(popupCss, /\.setting-row\s*{[^}]*padding:\s*5px 12px/s);
  assert.match(popupCss, /\.select-control\s*{[^}]*height:\s*28px/s);
  assert.doesNotMatch(popupHtml, /class="setting-hint"/);
});

test("the popup uses a compact position choice and no feedback notice", () => {
  assert.match(popupHtml, /<title>Popup as Tab<\/title>/);
  assert.match(popupHtml, /<h1>Popup as Tab<\/h1>/);
  assert.doesNotMatch(popupHtml, /Popup to Tab/);
  assert.match(popupHtml, />Popup tab position</);
  assert.match(popupHtml, /<option value="opening-order">Opening order<\/option>/);
  assert.match(popupHtml, /<option value="beside-current">Beside current<\/option>/);
  assert.match(popupHtml, />New tab position</);
  assert.match(popupHtml, /<option value="beside">Beside current<\/option>/);
  assert.match(popupHtml, /<option value="default">Browser default<\/option>/);
  assert.doesNotMatch(
    popupHtml,
    /id="(?:state-label|new-tab-placement-state|save-exclusions|save-status)"/,
  );
  assert.doesNotMatch(popupCode, /Site excluded|setFeedback/);
});
