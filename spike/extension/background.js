const TEST_HOST = "www.youtube.com";
const SOCKS_ENDPOINT = "SOCKS5 127.0.0.1:17891";
const PAC_SCRIPT = [
  "function FindProxyForURL(url, host) {",
  "  host = host.toLowerCase();",
  "  if (host === \"www.youtube.com\") {",
  "    return \"SOCKS5 127.0.0.1:17891\";",
  "  }",
  "  return \"DIRECT\";",
  "}"
].join("\n");

const STATE_KEY = "phase0";
const DEFAULT_STATE = {
  proxyApi: "UNKNOWN",
  levelOfControl: "unknown",
  pacStatus: "NOT APPLIED",
  lastProxyError: "none",
  lastOperation: "idle"
};

const NATIVE_HOST_NAME = "com.vpnroute.phase0b";
const NATIVE_EXPECTED_HOST = "SelectiveVpnRouter.NativeHost.Spike";
const NATIVE_TIMEOUT_MS = 5000;
const NATIVE_STATE_KEY = "phase0bNative";
const DEFAULT_NATIVE_STATE = {
  hostName: NATIVE_HOST_NAME,
  status: "UNKNOWN",
  lastPing: "never",
  requestId: "none",
  response: "none",
  lastError: "none"
};

let lastConsoleError = "";

function proxyAvailable() {
  return Boolean(chrome.proxy && chrome.proxy.settings);
}

function canControl(levelOfControl) {
  return levelOfControl === "controllable_by_this_extension" ||
    levelOfControl === "controlled_by_this_extension";
}

function isOurPac(value) {
  const data = value && value.pacScript && value.pacScript.data;
  if (!value || value.mode !== "pac_script" || typeof data !== "string") {
    return false;
  }

  const normalized = data.replace(/\r\n/g, "\n").trim();
  return value.pacScript.mandatory === true &&
    normalized === PAC_SCRIPT &&
    normalized.indexOf(SOCKS_ENDPOINT + "; DIRECT") === -1;
}

function storageGet() {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(STATE_KEY, (items) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }

      resolve(Object.assign({}, DEFAULT_STATE, items[STATE_KEY] || {}));
    });
  });
}

function storageSet(state) {
  return new Promise((resolve, reject) => {
    const stored = {};
    stored[STATE_KEY] = state;
    chrome.storage.local.set(stored, () => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }

      resolve(state);
    });
  });
}

async function saveState(patch) {
  const current = await storageGet();
  return storageSet(Object.assign({}, current, patch));
}

function getSettings() {
  return new Promise((resolve, reject) => {
    chrome.proxy.settings.get({ incognito: false }, (details) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }

      resolve(details);
    });
  });
}

function setPac() {
  return new Promise((resolve, reject) => {
    chrome.proxy.settings.set({
      scope: "regular",
      value: {
        mode: "pac_script",
        pacScript: {
          data: PAC_SCRIPT,
          mandatory: true
        }
      }
    }, () => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }

      resolve();
    });
  });
}

function clearSettings() {
  return new Promise((resolve, reject) => {
    chrome.proxy.settings.clear({ scope: "regular" }, () => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }

      resolve();
    });
  });
}

async function applyPac() {
  console.log("[VPN Route Phase0] applying PAC");
  if (!proxyAvailable()) {
    console.log("[VPN Route Phase0] chrome.proxy is missing");
    return saveState({
      proxyApi: "UNAVAILABLE",
      levelOfControl: "unavailable",
      pacStatus: "ERROR",
      lastOperation: "chrome.proxy is missing"
    });
  }

  let before;
  try {
    before = await getSettings();
  } catch (error) {
    return saveState({
      proxyApi: "AVAILABLE",
      pacStatus: "ERROR",
      lastOperation: "settings.get failed: " + error.message
    });
  }

  const levelOfControl = before.levelOfControl || "unknown";
  console.log("[VPN Route Phase0] levelOfControl=" + levelOfControl);
  if (!canControl(levelOfControl)) {
    console.log("[VPN Route Phase0] PAC not applied: " + levelOfControl);
    return saveState({
      proxyApi: "AVAILABLE",
      levelOfControl: levelOfControl,
      pacStatus: "NOT APPLIED",
      lastOperation: "Not applied. Proxy is not controllable by this extension (" + levelOfControl + ")."
    });
  }

  try {
    await setPac();
  } catch (error) {
    console.log("[VPN Route Phase0] PAC apply failed: " + error.message);
    return saveState({
      proxyApi: "AVAILABLE",
      levelOfControl: levelOfControl,
      pacStatus: "ERROR",
      lastOperation: "settings.set failed: " + error.message
    });
  }

  let after;
  try {
    after = await getSettings();
  } catch (error) {
    return saveState({
      proxyApi: "AVAILABLE",
      levelOfControl: levelOfControl,
      pacStatus: "ERROR",
      lastOperation: "settings.set returned, but settings.get failed: " + error.message
    });
  }

  const appliedLevel = after.levelOfControl || "unknown";
  console.log("[VPN Route Phase0] levelOfControl=" + appliedLevel);
  if (!isOurPac(after.value)) {
    const pacScript = after.value && after.value.pacScript;
    console.log("[VPN Route Phase0] effective proxy config is not this spike PAC");
    console.log("[VPN Route Phase0] effective mode=" + (after.value && after.value.mode) +
      " mandatory=" + (pacScript && pacScript.mandatory));
    return saveState({
      proxyApi: "AVAILABLE",
      levelOfControl: appliedLevel,
      pacStatus: "ERROR",
      lastOperation: "settings.set returned, but the effective proxy config is not this spike PAC."
    });
  }

  console.log("[VPN Route Phase0] PAC applied");
  return saveState({
    proxyApi: "AVAILABLE",
    levelOfControl: appliedLevel,
    pacStatus: "APPLIED",
    lastProxyError: "none",
    lastOperation: "PAC applied"
  });
}

async function clearProxy() {
  console.log("[VPN Route Phase0] clearing extension proxy");
  if (!proxyAvailable()) {
    return saveState({
      proxyApi: "UNAVAILABLE",
      levelOfControl: "unavailable",
      pacStatus: "ERROR",
      lastOperation: "chrome.proxy is missing"
    });
  }

  try {
    await clearSettings();
  } catch (error) {
    return saveState({
      proxyApi: "AVAILABLE",
      pacStatus: "ERROR",
      lastOperation: "settings.clear failed: " + error.message
    });
  }

  let after;
  try {
    after = await getSettings();
  } catch (error) {
    return saveState({
      proxyApi: "AVAILABLE",
      pacStatus: "ERROR",
      lastOperation: "settings.clear returned, but settings.get failed: " + error.message
    });
  }

  if (isOurPac(after.value)) {
    return saveState({
      proxyApi: "AVAILABLE",
      levelOfControl: after.levelOfControl || "unknown",
      pacStatus: "ERROR",
      lastOperation: "settings.clear returned, but this spike PAC is still effective."
    });
  }

  console.log("[VPN Route Phase0] extension proxy cleared");
  return saveState({
    proxyApi: "AVAILABLE",
    levelOfControl: after.levelOfControl || "unknown",
    pacStatus: "NOT APPLIED",
    lastOperation: "Extension proxy cleared"
  });
}

async function refreshObservedState() {
  if (!proxyAvailable()) {
    return saveState({
      proxyApi: "UNAVAILABLE",
      levelOfControl: "unavailable"
    });
  }

  const details = await getSettings();
  return saveState({
    proxyApi: "AVAILABLE",
    levelOfControl: details.levelOfControl || "unknown",
    pacStatus: isOurPac(details.value) ? "APPLIED" : "NOT APPLIED"
  });
}

function getNativeState() {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(NATIVE_STATE_KEY, (items) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }

      resolve(Object.assign({}, DEFAULT_NATIVE_STATE, items[NATIVE_STATE_KEY] || {}));
    });
  });
}

function setNativeState(state) {
  return new Promise((resolve, reject) => {
    const stored = {};
    stored[NATIVE_STATE_KEY] = state;
    chrome.storage.local.set(stored, () => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }

      resolve(state);
    });
  });
}

function newRequestId() {
  if (crypto && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

function sendNative(message) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      reject(new Error("No response from native host within " + NATIVE_TIMEOUT_MS + " ms"));
    }, NATIVE_TIMEOUT_MS);

    try {
      chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, message, (response) => {
        const error = chrome.runtime.lastError;
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) {
          reject(new Error(error.message));
          return;
        }

        resolve(response);
      });
    } catch (error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    }
  });
}

function describeBadPong(response, requestId) {
  if (!response || typeof response !== "object") return "Response is not an object";
  if (response.id !== requestId) return "Response id does not match request id";
  if (response.ok !== true) {
    const code = response.error && response.error.code;
    return "Host returned an error: " + (code || "unknown");
  }
  if (response.command !== "pong") return "Response command is not pong";
  if (response.host !== NATIVE_EXPECTED_HOST) return "Unexpected host name in response";
  if (typeof response.version !== "string") return "Response has no version";
  return "";
}

async function pingNativeHost() {
  const requestId = newRequestId();
  const startedAt = new Date().toISOString();
  console.log("[VPN Route Phase0] native ping id=" + requestId);

  if (!chrome.runtime.sendNativeMessage) {
    return setNativeState(Object.assign({}, DEFAULT_NATIVE_STATE, {
      status: "ERROR",
      lastPing: startedAt,
      requestId: requestId,
      lastError: "chrome.runtime.sendNativeMessage is missing"
    }));
  }

  let response;
  try {
    response = await sendNative({ id: requestId, command: "ping" });
  } catch (error) {
    console.log("[VPN Route Phase0] native ping failed: " + error.message);
    return setNativeState(Object.assign({}, DEFAULT_NATIVE_STATE, {
      status: "ERROR",
      lastPing: startedAt,
      requestId: requestId,
      lastError: error.message
    }));
  }

  const responseText = JSON.stringify(response);
  const problem = describeBadPong(response, requestId);
  if (problem) {
    console.log("[VPN Route Phase0] native ping bad response: " + problem);
    return setNativeState(Object.assign({}, DEFAULT_NATIVE_STATE, {
      status: "ERROR",
      lastPing: startedAt,
      requestId: requestId,
      response: responseText,
      lastError: problem
    }));
  }

  console.log("[VPN Route Phase0] native pong id=" + response.id);
  return setNativeState(Object.assign({}, DEFAULT_NATIVE_STATE, {
    status: "AVAILABLE",
    lastPing: startedAt,
    requestId: requestId,
    response: responseText,
    lastError: "none"
  }));
}

function onProxyError(details) {
  const parts = [];
  if (details && details.error) parts.push(details.error);
  if (details && details.details) parts.push(details.details);
  if (details && details.fatal) parts.push("fatal");
  const text = parts.join(" | ") || "unknown proxy error";
  if (text !== lastConsoleError) {
    lastConsoleError = text;
    console.log("[VPN Route Phase0] proxy error: " + text);
  }

  saveState({ lastProxyError: text }).catch((error) => {
    console.log("[VPN Route Phase0] failed to store proxy error: " + error.message);
  });
}

chrome.runtime.onInstalled.addListener(() => {
  applyPac().catch((error) => {
    console.log("[VPN Route Phase0] apply on install failed: " + error.message);
  });
});

chrome.runtime.onStartup.addListener(() => {
  applyPac().catch((error) => {
    console.log("[VPN Route Phase0] apply on startup failed: " + error.message);
  });
});

if (chrome.proxy && chrome.proxy.onProxyError) {
  chrome.proxy.onProxyError.addListener(onProxyError);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!sender || sender.id !== chrome.runtime.id || !message) return;

  const respond = (promise) => {
    promise.then(sendResponse, (error) => {
      sendResponse({
        proxyApi: "AVAILABLE",
        levelOfControl: "unknown",
        pacStatus: "ERROR",
        lastProxyError: "none",
        lastOperation: error.message
      });
    });
    return true;
  };

  if (message.type === "getState") return respond(refreshObservedState());
  if (message.type === "reapply") return respond(applyPac());
  if (message.type === "clear") return respond(clearProxy());

  const respondNative = (promise) => {
    promise.then(sendResponse, (error) => {
      sendResponse(Object.assign({}, DEFAULT_NATIVE_STATE, {
        status: "ERROR",
        lastError: error.message
      }));
    });
    return true;
  };

  if (message.type === "getNativeState") return respondNative(getNativeState());
  if (message.type === "nativePing") return respondNative(pingNativeHost());
});
