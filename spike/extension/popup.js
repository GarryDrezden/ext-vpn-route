const fields = {
  proxyApi: document.getElementById("proxy-api"),
  levelOfControl: document.getElementById("level-of-control"),
  pacStatus: document.getElementById("pac-status"),
  lastProxyError: document.getElementById("last-proxy-error"),
  lastOperation: document.getElementById("last-operation")
};

const nativeFields = {
  hostName: document.getElementById("native-host-name"),
  status: document.getElementById("native-status"),
  lastPing: document.getElementById("native-last-ping"),
  requestId: document.getElementById("native-request-id"),
  response: document.getElementById("native-response"),
  lastError: document.getElementById("native-last-error")
};

const reapplyButton = document.getElementById("reapply");
const clearButton = document.getElementById("clear");
const nativePingButton = document.getElementById("native-ping");

function render(state) {
  fields.proxyApi.textContent = state.proxyApi || "UNKNOWN";
  fields.levelOfControl.textContent = state.levelOfControl || "unknown";
  fields.pacStatus.textContent = state.pacStatus || "NOT APPLIED";
  fields.lastProxyError.textContent = state.lastProxyError || "none";
  fields.lastOperation.textContent = state.lastOperation || "idle";
}

function renderNative(state) {
  nativeFields.hostName.textContent = state.hostName || "com.vpnroute.phase0b";
  nativeFields.status.textContent = state.status || "UNKNOWN";
  nativeFields.lastPing.textContent = state.lastPing || "never";
  nativeFields.requestId.textContent = state.requestId || "none";
  nativeFields.response.textContent = state.response || "none";
  nativeFields.lastError.textContent = state.lastError || "none";
}

function send(type) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type }, (response) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }

      resolve(response || {});
    });
  });
}

async function refresh() {
  render(await send("getState"));
}

async function refreshNative() {
  renderNative(await send("getNativeState"));
}

async function run(type) {
  reapplyButton.disabled = true;
  clearButton.disabled = true;
  try {
    render(await send(type));
  } catch (error) {
    fields.pacStatus.textContent = "ERROR";
    fields.lastOperation.textContent = error.message;
  } finally {
    reapplyButton.disabled = false;
    clearButton.disabled = false;
  }
}

async function pingNative() {
  nativePingButton.disabled = true;
  nativeFields.status.textContent = "PINGING";
  try {
    renderNative(await send("nativePing"));
  } catch (error) {
    nativeFields.status.textContent = "ERROR";
    nativeFields.lastError.textContent = error.message;
  } finally {
    nativePingButton.disabled = false;
  }
}

reapplyButton.addEventListener("click", () => {
  run("reapply");
});

clearButton.addEventListener("click", () => {
  run("clear");
});

nativePingButton.addEventListener("click", () => {
  pingNative();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.phase0 && changes.phase0.newValue) {
    render(changes.phase0.newValue);
  }
  if (changes.phase0bNative && changes.phase0bNative.newValue) {
    renderNative(changes.phase0bNative.newValue);
  }
});

refresh().catch((error) => {
  fields.proxyApi.textContent = "UNKNOWN";
  fields.pacStatus.textContent = "ERROR";
  fields.lastOperation.textContent = error.message;
});

refreshNative().catch((error) => {
  nativeFields.status.textContent = "ERROR";
  nativeFields.lastError.textContent = error.message;
});
