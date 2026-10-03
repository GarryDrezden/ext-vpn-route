// Promise wrappers over callback-style chrome.* APIs. chrome.runtime.lastError becomes a rejection.

function call(chromeApi, invoke) {
  return new Promise((resolve, reject) => {
    try {
      invoke((result) => {
        const error = chromeApi.runtime.lastError;
        if (error) {
          reject(new Error(error.message || String(error)));
          return;
        }
        resolve(result);
      });
    } catch (error) {
      reject(error);
    }
  });
}

export function createChromeProxy(chromeApi) {
  const settings = chromeApi.proxy && chromeApi.proxy.settings;
  return Object.freeze({
    available: Boolean(settings),
    get: () => call(chromeApi, (done) => settings.get({ incognito: false }, done)),
    set: (value) => call(chromeApi, (done) => settings.set({ value, scope: "regular" }, done)),
    clear: () => call(chromeApi, (done) => settings.clear({ scope: "regular" }, done))
  });
}

export function createChromeStorage(chromeApi, key) {
  return Object.freeze({
    read: () => call(chromeApi, (done) => chromeApi.storage.local.get(key, done))
      .then((items) => (items ? items[key] : undefined)),
    write: (value) => call(chromeApi, (done) => chromeApi.storage.local.set({ [key]: value }, done))
  });
}
