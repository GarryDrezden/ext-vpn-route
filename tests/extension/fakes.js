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

function clone(value) {
  return value === undefined || value === null ? value : JSON.parse(JSON.stringify(value));
}

let clock = 0;
export function fakeNow() {
  clock++;
  return "2026-10-03T00:00:" + String(clock % 60).padStart(2, "0") + ".000Z";
}
