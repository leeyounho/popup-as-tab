const enabledInput = document.querySelector("#enabled");
const popupPlacementSelect = document.querySelector("#popup-placement");
const newTabPlacementSelect = document.querySelector("#new-tab-next-to-current");
const excludedUrlsInput = document.querySelector("#excluded-urls");
const addCurrentPageButton = document.querySelector("#add-current-page");
const addCurrentPageLabel = document.querySelector("#add-current-label");
const ruleCount = document.querySelector("#rule-count");
const EXCLUDED_URL_SAVE_DELAY_MS = 200;

const protectedProtocols = new Set([
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

let savedExcludedUrls = [];
let currentPage = { kind: "loading" };
let busy = false;
let extensionEnabled = false;
let popupPlacementSaving = false;
let newTabPlacementSaving = false;
let excludedUrlsSaveTimer;
let excludedUrlsSaveVersion = 0;

function renderNewTabPlacementAvailability() {
  newTabPlacementSelect.disabled = !extensionEnabled || newTabPlacementSaving;
}

function renderPopupPlacementAvailability() {
  popupPlacementSelect.disabled = !extensionEnabled || popupPlacementSaving;
}

function renderEnabled(enabled) {
  extensionEnabled = enabled;
  enabledInput.checked = enabled;
  renderPopupPlacementAvailability();
  renderNewTabPlacementAvailability();
}

function renderPopupPlacement(placement) {
  popupPlacementSelect.value = placement === "besideCurrent"
    ? "beside-current"
    : "opening-order";
}

function renderNewTabPlacement(enabled) {
  newTabPlacementSelect.value = enabled ? "beside" : "default";
}

function readExcludedUrls() {
  return [...new Set(excludedUrlsInput.value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean))];
}

function rulesAreEqual(left, right) {
  return left.length === right.length && left.every((rule, index) => rule === right[index]);
}

function renderEditor() {
  const rules = readExcludedUrls();
  ruleCount.textContent = String(rules.length);
  ruleCount.setAttribute("aria-label", rules.length + " exclusion rule" + (rules.length === 1 ? "" : "s"));
}

function createPageRule(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const protocol = url.protocol.toLowerCase();
    if (protectedProtocols.has(protocol)) {
      return { kind: "protected" };
    }
    if (!["http:", "https:", "file:", "ftp:"].includes(protocol)) {
      return { kind: "unsupported" };
    }

    url.search = "";
    url.hash = "";
    const rule = ["http:", "https:"].includes(protocol)
      ? url.host.toLowerCase() + url.pathname
      : url.href;
    return { kind: "ready", rule };
  } catch {
    return { kind: "invalid" };
  }
}

function renderCurrentPage() {
  const rules = readExcludedUrls();
  const alreadyExcluded = currentPage.kind === "ready" && rules.includes(currentPage.rule);

  if (currentPage.kind === "loading") {
    addCurrentPageLabel.textContent = "Exclude";
  } else if (currentPage.kind === "ready") {
    addCurrentPageLabel.textContent = alreadyExcluded ? "Excluded" : "Exclude";
  } else if (currentPage.kind === "protected") {
    addCurrentPageLabel.textContent = "Protected";
  } else {
    addCurrentPageLabel.textContent = "Unavailable";
  }

  addCurrentPageButton.disabled = busy || currentPage.kind !== "ready" || alreadyExcluded;
}

function setBusy(nextBusy) {
  busy = nextBusy;
  excludedUrlsInput.disabled = nextBusy;
  renderEditor();
  renderCurrentPage();
}

function cancelPendingExcludedUrlsSave() {
  if (excludedUrlsSaveTimer === undefined) return;
  clearTimeout(excludedUrlsSaveTimer);
  excludedUrlsSaveTimer = undefined;
}

function saveExcludedUrls() {
  cancelPendingExcludedUrlsSave();
  const excludedUrls = readExcludedUrls();
  const saveVersion = ++excludedUrlsSaveVersion;
  setBusy(true);
  chrome.storage.local.set({ excludedUrls }, () => {
    const error = chrome.runtime.lastError?.message;
    setBusy(false);
    if (error || saveVersion !== excludedUrlsSaveVersion) return;

    savedExcludedUrls = excludedUrls;
    excludedUrlsInput.value = excludedUrls.join("\n");
    renderEditor();
    renderCurrentPage();
  });
}

function saveExcludedUrlsOnClose() {
  cancelPendingExcludedUrlsSave();
  const excludedUrls = readExcludedUrls();
  if (rulesAreEqual(excludedUrls, savedExcludedUrls)) return;
  excludedUrlsSaveVersion += 1;
  savedExcludedUrls = excludedUrls;
  chrome.storage.local.set({ excludedUrls });
}

function scheduleExcludedUrlsSave() {
  cancelPendingExcludedUrlsSave();
  excludedUrlsSaveTimer = setTimeout(() => {
    excludedUrlsSaveTimer = undefined;
    const excludedUrls = readExcludedUrls();
    const saveVersion = ++excludedUrlsSaveVersion;
    chrome.storage.local.set({ excludedUrls }, () => {
      if (chrome.runtime.lastError || saveVersion !== excludedUrlsSaveVersion) return;
      savedExcludedUrls = excludedUrls;
    });
  }, EXCLUDED_URL_SAVE_DELAY_MS);
}

function addCurrentPage() {
  if (currentPage.kind !== "ready") return;

  const excludedUrls = readExcludedUrls();
  if (excludedUrls.includes(currentPage.rule)) return;

  excludedUrls.push(currentPage.rule);
  excludedUrlsInput.value = excludedUrls.join("\n");
  renderEditor();
  saveExcludedUrls();
}

chrome.storage.local.get({
  enabled: true,
  excludedUrls: [],
  popupPlacement: "openingOrder",
  newTabNextToCurrent: true,
}, (settings) => {
  void chrome.runtime.lastError;
  renderEnabled(settings.enabled !== false);
  renderPopupPlacement(settings.popupPlacement);
  renderNewTabPlacement(settings.newTabNextToCurrent !== false);
  savedExcludedUrls = Array.isArray(settings.excludedUrls)
    ? [...new Set(settings.excludedUrls
      .filter((rule) => typeof rule === "string")
      .map((rule) => rule.trim())
      .filter(Boolean))]
    : [];
  excludedUrlsInput.value = savedExcludedUrls.join("\n");
  renderEditor();
  renderCurrentPage();
});

chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  const queryError = chrome.runtime.lastError?.message;
  const rawUrl = tabs[0]?.url;
  if (queryError || !rawUrl) {
    currentPage = { kind: "unavailable" };
  } else {
    currentPage = createPageRule(rawUrl);
  }
  renderCurrentPage();
});

enabledInput.addEventListener("change", () => {
  const enabled = enabledInput.checked;
  renderEnabled(enabled);
  chrome.storage.local.set({ enabled }, () => {
    const error = chrome.runtime.lastError?.message;
    if (error) {
      renderEnabled(!enabled);
      return;
    }
    renderEnabled(enabled);
  });
});

popupPlacementSelect.addEventListener("change", () => {
  const popupPlacement = popupPlacementSelect.value === "beside-current"
    ? "besideCurrent"
    : "openingOrder";
  popupPlacementSaving = true;
  renderPopupPlacementAvailability();
  chrome.storage.local.set({ popupPlacement }, () => {
    popupPlacementSaving = false;
    const error = chrome.runtime.lastError?.message;
    if (error) {
      renderPopupPlacement(popupPlacement === "besideCurrent" ? "openingOrder" : "besideCurrent");
    }
    renderPopupPlacementAvailability();
  });
});

newTabPlacementSelect.addEventListener("change", () => {
  const newTabNextToCurrent = newTabPlacementSelect.value === "beside";
  newTabPlacementSaving = true;
  renderNewTabPlacementAvailability();
  chrome.storage.local.set({ newTabNextToCurrent }, () => {
    newTabPlacementSaving = false;
    const error = chrome.runtime.lastError?.message;
    if (error) {
      renderNewTabPlacement(!newTabNextToCurrent);
    }
    renderNewTabPlacementAvailability();
  });
});

addCurrentPageButton.addEventListener("click", addCurrentPage);
excludedUrlsInput.addEventListener("input", () => {
  renderEditor();
  renderCurrentPage();
  scheduleExcludedUrlsSave();
});
window.addEventListener("pagehide", saveExcludedUrlsOnClose);
window.addEventListener("unload", saveExcludedUrlsOnClose);
