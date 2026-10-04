/**
 * In-memory model of Chromium proxy settings as seen by one extension.
 * owner: "none" | "this" | "other" | "policy".
 */
export function createFakeProxy(options = {}) {
  const fake = {
    available: options.available !== false,
    owner: options.owner || "none",
    ours: null,
    foreign: options.foreign || { mode: "fixed_servers", rules: { singleProxy: { host: "10.9.9.9", port: 8080 } } },
    returnsData: options.returnsData !== false,
    failures: { get: [], set: [], clear: [] },
    calls: { get: 0, set: [], clear: 0 },
    ignoreSet: false,
    transformRead: null,

    async get() {
      fake.calls.get++;
      const failure = fake.failures.get.shift();
      if (failure) throw new Error(failure);
      if (fake.owner === "other") return { levelOfControl: "controlled_by_other_extensions", value: clone(fake.foreign) };
      if (fake.owner === "policy") return { levelOfControl: "not_controllable", value: clone(fake.foreign) };
      if (fake.owner === "this") {
        let value = clone(fake.ours);
        if (!fake.returnsData && value.pacScript) delete value.pacScript.data;
        if (fake.transformRead) value = fake.transformRead(value);
        return { levelOfControl: "controlled_by_this_extension", value };
      }
      return { levelOfControl: "controllable_by_this_extension", value: { mode: "system" } };
    },

    async set(value) {
      fake.calls.set.push(clone(value));
      const failure = fake.failures.set.shift();
      if (failure) throw new Error(failure);
      if (fake.ignoreSet || fake.owner === "other" || fake.owner === "policy") return;
      fake.owner = "this";
      fake.ours = clone(value);
    },

    async clear() {
      fake.calls.clear++;
      const failure = fake.failures.clear.shift();
      if (failure) throw new Error(failure);
      if (fake.owner === "this") {
        fake.owner = "none";
        fake.ours = null;
      }
    }
  };
  return fake;
}

export function createFakeStorage(initial) {
  const storage = {
    value: initial === undefined ? undefined : clone(initial),
    writes: 0,
    async read() {
      return storage.value === undefined ? undefined : clone(storage.value);
    },
    async write(value) {
      storage.writes++;
      storage.value = clone(value);
    }
  };
  return storage;
}

/**
 * chrome.runtime stand-in for sendNativeMessage. `handler(hostName, message)` returns
 * { response } | { lastError: string } | { hang: true } | { throws: string }.
 */
export function createFakeNativeRuntime(handler) {
  const runtime = {
    lastError: undefined,
    calls: [],
    sendNativeMessage(hostName, message, callback) {
      runtime.calls.push({ hostName, message: clone(message) });
      const outcome = handler(hostName, clone(message)) || {};
      if (outcome.throws) throw new Error(outcome.throws);
      if (outcome.hang) return;
      setImmediate(() => {
        if (outcome.lastError) {
          runtime.lastError = { message: outcome.lastError };
          try { callback(undefined); } finally { runtime.lastError = undefined; }
        } else {
          callback(clone(outcome.response));
        }
      });
    }
  };
  return runtime;
}

export const GEN_A = "9b2f6c1e-1d2a-4f57-9a43-3f2a9d7c1b10";
export const GEN_B = "4c1d8e2f-7a6b-4e3c-9d2a-1b0f5e6d7c8a";
export const TEST_ENDPOINT = Object.freeze({ host: "127.0.0.1", port: 17891 });
export const READY = Object.freeze({ status: "Ready", endpoint: TEST_ENDPOINT });
export const UNAVAILABLE = Object.freeze({ status: "Unavailable", endpoint: null });

export function hostOk(message, result) {
  return { response: { protocolVersion: 1, requestId: message.requestId, ok: true, result } };
}

export function hostError(message, code, text = "failure") {
  return { response: { protocolVersion: 1, requestId: message.requestId, ok: false, error: { code, message: text } } };
}

/**
 * A VPN Route native host relaying a paged Service snapshot of `state`.
 * options: generation, browserProxy, pageSize, pageBudgetBytes.
 */
export function nativeHostServing(state, options = {}) {
  const generation = options.generation || GEN_A;
  const browserProxy = options.browserProxy === undefined ? READY : options.browserProxy;
  const pageSize = options.pageSize || 2;
  return (hostName, message) => {
    if (message.command === "getStateManifest") {
      return hostOk(message, {
        schemaVersion: state.schemaVersion,
        stateGeneration: generation,
        revision: state.revision,
        defaultRoute: state.defaultRoute,
        ruleCount: state.rules.length,
        pageBudgetBytes: options.pageBudgetBytes || 520192,
        browserProxy: clone(browserProxy)
      });
    }
    if (message.command === "getStatePage") {
      if (message.stateGeneration !== generation || message.revision !== state.revision) return hostError(message, "snapshot_changed");
      if (message.startIndex >= state.rules.length) return hostError(message, "invalid_cursor");
      const rules = state.rules.slice(message.startIndex, message.startIndex + pageSize);
      const end = message.startIndex + rules.length;
      return hostOk(message, {
        stateGeneration: generation,
        revision: state.revision,
        startIndex: message.startIndex,
        nextIndex: end === state.rules.length ? null : end,
        rules: clone(rules)
      });
    }
    return hostError(message, "unknown_command");
  };
}

/** Back-compat helper for tests that only care about state + endpoint readiness. */
export function nativeHostReturning(state, browserProxy = READY, generation = GEN_A) {
  return nativeHostServing(state, { browserProxy, generation });
}

export function nativeHostFailing(code, message = "failure") {
  return (hostName, request) => ({
    response: { protocolVersion: 1, requestId: request.requestId, ok: false, error: { code, message } }
  });
}

export function routingState(revision, overrides = {}) {
  return {
    schemaVersion: 1,
    revision,
    defaultRoute: "Direct",
    rules: [
      {
        id: "youtube", name: "YouTube", host: "youtube.com", matchType: "DomainAndSubdomains",
        routeMode: "VPN", enabled: true, source: "User", notes: null
      }
    ],
    ...overrides
  };
}

function clone(value) {
  return value === undefined || value === null ? value : JSON.parse(JSON.stringify(value));
}

let clock = 0;
export function fakeNow() {
  clock++;
  return "2026-10-03T00:00:" + String(clock % 60).padStart(2, "0") + ".000Z";
}
