import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_NATIVE_TIMEOUT_MS,
  DEFAULT_SNAPSHOT_TIMEOUT_MS,
  NativeErrorCode,
  SnapshotLimits,
  createNativeStateProvider
} from "../../src/extension/state/native-state-provider.js";
import { createBrowserRoutingSnapshot } from "../../src/extension/state/snapshot.js";
import { NATIVE_HOST_NAME } from "../../src/extension/runtime/config.js";
import {
  GEN_A,
  GEN_B,
  READY,
  UNAVAILABLE,
  createFakeNativeRuntime,
  fakeNow,
  hostError,
  hostOk,
  nativeHostFailing,
  nativeHostServing,
  routingState
} from "./fakes.js";

let counter = 0;

function withPing(handler) {
  return (host, message) => {
    if (message.command === "ping") {
      return {
        response: {
          protocolVersion: 1,
          requestId: message.requestId,
          ok: true,
          result: {
            command: "pong",
            host: "SelectiveVpnRouter.NativeHost",
            protocolVersion: 1,
            hostVersion: "0.5.0-test"
          }
        }
      };
    }
    return handler(host, message);
  };
}

function provider(handler, extra = {}) {
  const runtime = createFakeNativeRuntime(withPing(handler));
  const instance = createNativeStateProvider({
    runtime,
    hostName: NATIVE_HOST_NAME,
    newRequestId: () => "req-" + ++counter,
    now: fakeNow,
    ...extra
  });
  return { runtime, provider: instance };
}

function stateWith(count, revision = 42) {
  const rules = [];
  for (let i = 0; i < count; i++) {
    rules.push({
      id: "r-" + String(i).padStart(5, "0"), name: "Rule " + i, host: "site" + i + ".example",
      matchType: i % 2 ? "ExactHost" : "DomainAndSubdomains", routeMode: i % 3 ? "VPN" : "Direct",
      enabled: true, source: "User", notes: null
    });
  }
  return { schemaVersion: 1, revision, defaultRoute: "Direct", rules };
}

/** Wraps a serving handler and lets a test rewrite manifest or page results. */
function tamper(base, { manifest, page } = {}) {
  return (hostName, message) => {
    const outcome = base(hostName, message);
    if (outcome.response && outcome.response.ok) {
      if (message.command === "getStateManifest" && manifest) outcome.response.result = manifest(outcome.response.result);
      if (message.command === "getStatePage" && page) outcome.response.result = page(outcome.response.result, message);
    }
    return outcome;
  };
}

async function failure(handler, extra) {
  const result = await provider(handler, extra).provider.getSnapshot();
  assert.equal(result.ok, false);
  return result;
}

describe("NativeStateProvider requests", () => {
  test("manifest first, then pages for the same identity and consecutive cursors", async () => {
    const { runtime, provider: p } = provider(nativeHostServing(stateWith(5), { pageSize: 2 }));
    const result = await p.getSnapshot();

    assert.equal(result.ok, true);
    assert.ok(runtime.calls.length >= 5);
    assert.ok(runtime.calls.every((call) => call.hostName === "com.vpnroute.browser"));
    assert.equal(runtime.calls[0].message.command, "ping");
    assert.deepEqual(Object.keys(runtime.calls[1].message), ["protocolVersion", "requestId", "command"]);
    assert.equal(runtime.calls[1].message.command, "getStateManifest");
    for (const [i, start] of [[2, 0], [3, 2], [4, 4]]) {
      const message = runtime.calls[i].message;
      assert.deepEqual(Object.keys(message), ["protocolVersion", "requestId", "command", "stateGeneration", "revision", "startIndex"]);
      assert.equal(message.command, "getStatePage");
      assert.equal(message.stateGeneration, GEN_A);
      assert.equal(message.revision, 42);
      assert.equal(message.startIndex, start);
    }
    assert.deepEqual(result.stats, { attempts: 1, messages: 4, pages: 3, largestPageBytes: result.stats.largestPageBytes, totalBytes: result.stats.totalBytes });
    assert.ok(result.stats.largestPageBytes > 0 && result.stats.totalBytes >= result.stats.largestPageBytes);
  });

  test("an empty state needs only the manifest", async () => {
    const { runtime, provider: p } = provider(nativeHostServing({ schemaVersion: 1, revision: 0, defaultRoute: "Direct", rules: [] }));
    const result = await p.getSnapshot();
    assert.equal(result.ok, true);
    assert.equal(runtime.calls.length, 2);
    assert.equal(runtime.calls[0].message.command, "ping");
    assert.deepEqual(result.snapshot.state.rules, []);
    assert.equal(result.stats.pages, 0);
  });

  test("returns a frozen canonical snapshot with identity and proxy readiness next to the state", async () => {
    const state = routingState(42);
    state.rules[0].host = "YouTube.COM.";
    const result = await provider(nativeHostServing(state)).provider.getSnapshot();

    assert.equal(result.ok, true);
    assert.equal(result.transport, "AVAILABLE");
    assert.equal(result.service, "AVAILABLE");
    assert.equal(result.state, "AVAILABLE");
    assert.equal(result.browserProxy, "READY");
    assert.deepEqual(result.identity, { stateGeneration: GEN_A, revision: 42 });
    assert.equal(result.snapshot.state.rules[0].host, "youtube.com");
    assert.deepEqual(result.snapshot.browserProxy, READY);
    assert.ok(Object.isFrozen(result.snapshot));
    assert.deepEqual(Object.keys(result.snapshot), ["identity", "state", "browserProxy"]);
    assert.deepEqual(Object.keys(result.snapshot.state), ["schemaVersion", "revision", "defaultRoute", "rules"]);
  });

  test("Unavailable browser proxy still yields the full validated state", async () => {
    const result = await provider(nativeHostServing(stateWith(3), { browserProxy: UNAVAILABLE })).provider.getSnapshot();
    assert.equal(result.ok, true);
    assert.equal(result.state, "AVAILABLE");
    assert.equal(result.browserProxy, "UNAVAILABLE");
    assert.deepEqual(result.snapshot.browserProxy, UNAVAILABLE);
    assert.equal(result.snapshot.state.rules.length, 3);
  });

  test("each message uses a fresh request id", async () => {
    const { runtime, provider: p } = provider(nativeHostServing(stateWith(3), { pageSize: 1 }));
    await p.getSnapshot();
    const ids = runtime.calls.map((call) => call.message.requestId);
    assert.equal(new Set(ids).size, ids.length);
  });

  test("default request id is a UUID", async () => {
    const runtime = createFakeNativeRuntime(nativeHostServing(routingState(1)));
    const p = createNativeStateProvider({ runtime, hostName: NATIVE_HOST_NAME });
    const result = await p.getSnapshot();
    assert.match(result.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  test("rejects invalid host names and a missing API at construction", () => {
    const runtime = createFakeNativeRuntime(() => ({}));
    for (const hostName of ["", "com.vpnroute.*", "COM.VPN", "../evil", "a..b", 7]) {
      assert.throws(() => createNativeStateProvider({ runtime, hostName }), /Invalid native messaging host name/);
    }
    assert.throws(() => createNativeStateProvider({ runtime: {}, hostName: NATIVE_HOST_NAME }), /not available/);
  });

  test("limits and timeouts", () => {
    assert.equal(DEFAULT_NATIVE_TIMEOUT_MS, 5000);
    assert.equal(DEFAULT_SNAPSHOT_TIMEOUT_MS, 60000);
    assert.equal(SnapshotLimits.maxRules, 10000);
    assert.equal(SnapshotLimits.maxPages, 160);
    assert.equal(SnapshotLimits.maxAttempts, 2);
    assert.ok(SnapshotLimits.maxPageBytes < 1024 * 1024);
  });
});

describe("NativeStateProvider transport errors", () => {
  const lastErrors = [
    ["Specified native messaging host not found.", NativeErrorCode.HostNotFound],
    ["Access to the specified native messaging host is forbidden.", NativeErrorCode.AccessForbidden],
    ["Native host has exited.", NativeErrorCode.HostExited],
    ["Error when communicating with the native messaging host.", NativeErrorCode.TransportError]
  ];
  for (const [message, code] of lastErrors) {
    test("lastError '" + message + "' -> " + code, async () => {
      const result = await failure(() => ({ lastError: message }));
      assert.equal(result.error.code, code);
      assert.equal(result.transport, "ERROR");
      assert.equal(result.service, "UNKNOWN");
      assert.equal(result.state, "UNKNOWN");
      assert.equal(result.browserProxy, "UNKNOWN");
      assert.equal(result.error.message, message);
    });
  }

  test("timeout", async () => {
    const result = await failure(() => ({ hang: true }), { timeoutMs: 20 });
    assert.equal(result.error.code, NativeErrorCode.Timeout);
    assert.equal(result.transport, "ERROR");
  });

  test("a page that never arrives fails the whole snapshot; no partial state", async () => {
    const serve = nativeHostServing(stateWith(5), { pageSize: 2 });
    let pages = 0;
    const result = await failure((host, message) => {
      if (message.command === "getStatePage" && ++pages === 2) return { hang: true };
      return serve(host, message);
    }, { timeoutMs: 300 });
    assert.equal(result.error.code, NativeErrorCode.Timeout);
    assert.deepEqual(result.identity, { stateGeneration: GEN_A, revision: 42 });
    assert.equal("snapshot" in result, false);
  });

  test("a late response after the timeout is ignored", async () => {
    let late;
    const runtime = {
      lastError: undefined,
      sendNativeMessage: (host, message, callback) => { late = () => callback({ protocolVersion: 1, requestId: message.requestId, ok: true, result: {} }); }
    };
    const p = createNativeStateProvider({ runtime, hostName: NATIVE_HOST_NAME, timeoutMs: 10 });
    const result = await p.getSnapshot();
    assert.equal(result.error.code, NativeErrorCode.Timeout);
    late();
  });

  test("synchronous throw from sendNativeMessage", async () => {
    const result = await failure(() => ({ throws: "Invalid native messaging host name specified." }));
    assert.equal(result.error.code, NativeErrorCode.TransportError);
  });

  test("long lastError text is clipped", async () => {
    const result = await failure(() => ({ lastError: "x".repeat(5000) }));
    assert.ok(result.error.message.length < 300);
  });

  test("overall snapshot deadline bounds a slow multi-page fetch", async () => {
    let time = 0;
    const serve = nativeHostServing(stateWith(10), { pageSize: 1 });
    const result = await failure((host, message) => { time += 10000; return serve(host, message); },
      { clock: () => time, snapshotTimeoutMs: 25000 });
    assert.equal(result.error.code, NativeErrorCode.SnapshotTimeout);
    assert.ok(result.stats.messages <= 4);
  });
});

describe("NativeStateProvider envelope validation", () => {
  const manifestOnly = (extra) => (host, message) => ({
    response: { ...nativeHostServing(routingState(5))(host, message).response, ...extra(message) }
  });

  const malformed = [
    ["undefined", undefined],
    ["null", null],
    ["string", "pong"],
    ["array", [1]],
    ["no ok", { protocolVersion: 1, requestId: "x", result: {} }],
    ["ok not boolean", { protocolVersion: 1, requestId: "x", ok: "true", result: {} }]
  ];
  for (const [name, response] of malformed) {
    test("malformed: " + name, async () => {
      const result = await failure(() => ({ response }));
      assert.equal(result.error.code, NativeErrorCode.MalformedResponse);
      assert.equal(result.transport, "ERROR");
    });
  }

  test("malformed: extra envelope field", async () => {
    const result = await failure(manifestOnly(() => ({ debug: "x" })));
    assert.equal(result.error.code, NativeErrorCode.MalformedResponse);
  });

  test("malformed: success with error field", async () => {
    const result = await failure(manifestOnly(() => ({ error: { code: "x", message: "y" } })));
    assert.equal(result.error.code, NativeErrorCode.MalformedResponse);
  });

  for (const version of [0, 2, "1", null, undefined]) {
    test("unsupported protocolVersion " + String(version), async () => {
      const result = await failure(manifestOnly(() => ({ protocolVersion: version })));
      assert.equal(result.error.code, NativeErrorCode.UnsupportedProtocol);
    });
  }

  test("mismatched or null requestId on success", async () => {
    for (const requestId of ["someone-else", null]) {
      const result = await failure(manifestOnly(() => ({ requestId })));
      assert.equal(result.error.code, NativeErrorCode.RequestIdMismatch);
    }
  });

  test("mismatched requestId on a page", async () => {
    const serve = nativeHostServing(stateWith(3));
    const result = await failure((host, message) => {
      const outcome = serve(host, message);
      if (message.command === "getStatePage") outcome.response.requestId = "other";
      return outcome;
    });
    assert.equal(result.error.code, NativeErrorCode.RequestIdMismatch);
  });

  test("mismatched requestId on error", async () => {
    const result = await failure(() => ({
      response: { protocolVersion: 1, requestId: "other", ok: false, error: { code: "service_unavailable", message: "m" } }
    }));
    assert.equal(result.error.code, NativeErrorCode.RequestIdMismatch);
  });

  const hostErrors = [
    ["service_unavailable", "UNAVAILABLE", "UNKNOWN"],
    ["service_timeout", "UNAVAILABLE", "UNKNOWN"],
    ["service_error", "UNAVAILABLE", "UNKNOWN"],
    ["service_untrusted", "UNAVAILABLE", "UNKNOWN"],
    ["browser_state_unavailable", "AVAILABLE", "UNAVAILABLE"],
    ["invalid_service_response", "UNKNOWN", "UNKNOWN"]
  ];
  for (const [code, service, state] of hostErrors) {
    test("ok:false " + code + " -> host_error, Service " + service + ", State " + state, async () => {
      const result = await failure(nativeHostFailing(code));
      assert.equal(result.error.code, NativeErrorCode.HostError);
      assert.equal(result.error.hostErrorCode, code);
      assert.equal(result.transport, "AVAILABLE");
      assert.equal(result.service, service);
      assert.equal(result.state, state);
    });
  }

  test("ok:false forbidden_origin with requestId null is a host error", async () => {
    const result = await failure(() => ({
      response: { protocolVersion: 1, requestId: null, ok: false, error: { code: "forbidden_origin", message: "Caller origin is not allowed." } }
    }));
    assert.equal(result.error.code, NativeErrorCode.HostError);
    assert.equal(result.error.hostErrorCode, "forbidden_origin");
    assert.equal(result.service, "UNKNOWN");
  });

  const badErrors = [
    ["missing error", { protocolVersion: 1, requestId: "R", ok: false }],
    ["error not object", { protocolVersion: 1, requestId: "R", ok: false, error: "boom" }],
    ["error code with spaces", { protocolVersion: 1, requestId: "R", ok: false, error: { code: "a b", message: "m" } }],
    ["error extra field", { protocolVersion: 1, requestId: "R", ok: false, error: { code: "x", message: "m", stack: "at ..." } }],
    ["error and result", { protocolVersion: 1, requestId: "R", ok: false, error: { code: "x", message: "m" }, result: {} }]
  ];
  for (const [name, response] of badErrors) {
    test("malformed error envelope: " + name, async () => {
      const result = await failure((host, message) => ({ response: JSON.parse(JSON.stringify(response).replace("\"R\"", JSON.stringify(message.requestId))) }));
      assert.equal(result.error.code, NativeErrorCode.MalformedResponse);
    });
  }
});

describe("NativeStateProvider manifest validation", () => {
  const cases = [
    ["integration v1 missing serviceVersion", (m) => ({ ...m, integrationApiVersion: 1, capabilities: ["browserExplicitSocks"] }), NativeErrorCode.InvalidManifest],
    ["unsupported integration major", (m) => ({ ...m, integrationApiVersion: 2, serviceVersion: "x", capabilities: ["browserRoutingState"] }), NativeErrorCode.IntegrationApiIncompatible],
    ["missing ruleCount", (m) => { const { ruleCount, ...rest } = m; return rest; }, NativeErrorCode.InvalidManifest],
    ["schemaVersion 2", (m) => ({ ...m, schemaVersion: 2 }), NativeErrorCode.InvalidManifest],
    ["uppercase generation", (m) => ({ ...m, stateGeneration: GEN_A.toUpperCase() }), NativeErrorCode.InvalidManifest],
    ["generation not a UUID", (m) => ({ ...m, stateGeneration: "../../state" }), NativeErrorCode.InvalidManifest],
    ["negative revision", (m) => ({ ...m, revision: -1 }), NativeErrorCode.InvalidManifest],
    ["revision beyond 2^53-1", (m) => ({ ...m, revision: 2 ** 53 }), NativeErrorCode.InvalidManifest],
    ["fractional ruleCount", (m) => ({ ...m, ruleCount: 1.5 }), NativeErrorCode.InvalidManifest],
    ["ruleCount over 10000", (m) => ({ ...m, ruleCount: 10001 }), NativeErrorCode.LimitExceeded],
    ["zero page budget", (m) => ({ ...m, pageBudgetBytes: 0 }), NativeErrorCode.InvalidManifest],
    ["page budget over 512 KiB", (m) => ({ ...m, pageBudgetBytes: 512 * 1024 + 1 }), NativeErrorCode.InvalidManifest],
    ["browserProxy missing endpoint", (m) => ({ ...m, browserProxy: { status: "Ready" } }), NativeErrorCode.InvalidEndpoint],
    ["Ready with null endpoint", (m) => ({ ...m, browserProxy: { status: "Ready", endpoint: null } }), NativeErrorCode.InvalidEndpoint],
    ["Unavailable with an endpoint", (m) => ({ ...m, browserProxy: { status: "Unavailable", endpoint: { host: "127.0.0.1", port: 1 } } }), NativeErrorCode.InvalidEndpoint],
    ["unknown status", (m) => ({ ...m, browserProxy: { status: "ready", endpoint: null } }), NativeErrorCode.InvalidEndpoint],
    ["remote endpoint", (m) => ({ ...m, browserProxy: { status: "Ready", endpoint: { host: "192.168.1.10", port: 1080 } } }), NativeErrorCode.InvalidEndpoint],
    ["wildcard endpoint", (m) => ({ ...m, browserProxy: { status: "Ready", endpoint: { host: "0.0.0.0", port: 1080 } } }), NativeErrorCode.InvalidEndpoint],
    ["hostname endpoint", (m) => ({ ...m, browserProxy: { status: "Ready", endpoint: { host: "localhost", port: 1080 } } }), NativeErrorCode.InvalidEndpoint],
    ["IPv6 endpoint", (m) => ({ ...m, browserProxy: { status: "Ready", endpoint: { host: "::1", port: 1080 } } }), NativeErrorCode.InvalidEndpoint],
    ["port 0", (m) => ({ ...m, browserProxy: { status: "Ready", endpoint: { host: "127.0.0.1", port: 0 } } }), NativeErrorCode.InvalidEndpoint],
    ["endpoint extra field", (m) => ({ ...m, browserProxy: { status: "Ready", endpoint: { host: "127.0.0.1", port: 1, scheme: "http" } } }), NativeErrorCode.InvalidEndpoint],
    ["invalid defaultRoute", (m) => ({ ...m, defaultRoute: "Default" }), NativeErrorCode.InvalidState]
  ];
  for (const [name, change, code] of cases) {
    test(name + " -> " + code + ", no pages requested", async () => {
      const { runtime, provider: p } = provider(tamper(nativeHostServing(stateWith(3)), { manifest: change }));
      const result = await p.getSnapshot();
      assert.equal(result.ok, false);
      assert.equal(result.error.code, code);
      assert.equal(result.service, "AVAILABLE");
      assert.equal(result.state, "INVALID");
      if (code !== NativeErrorCode.InvalidState) {
        assert.equal(runtime.calls.length, 2);
        assert.equal(runtime.calls[0].message.command, "ping");
        assert.equal(runtime.calls[1].message.command, "getStateManifest");
      }
    });
  }

  test("additive unknown manifest field is accepted", async () => {
    const result = await provider(tamper(nativeHostServing(stateWith(3)), {
      manifest: (m) => ({ ...m, futureSliceField: "ignored" })
    })).provider.getSnapshot();
    assert.equal(result.ok, true);
  });

  test("other loopback addresses are accepted", async () => {
    const browserProxy = { status: "Ready", endpoint: { host: "127.10.0.2", port: 1080 } };
    const result = await provider(nativeHostServing(routingState(1), { browserProxy })).provider.getSnapshot();
    assert.equal(result.ok, true);
    assert.deepEqual(result.snapshot.browserProxy.endpoint, { host: "127.10.0.2", port: 1080 });
  });
});

describe("NativeStateProvider page validation", () => {
  const cases = [
    ["foreign generation", (p) => ({ ...p, stateGeneration: GEN_B })],
    ["different revision", (p) => ({ ...p, revision: p.revision + 1 })],
    ["wrong startIndex echo", (p) => ({ ...p, startIndex: p.startIndex + 1 })],
    ["empty rules", (p) => ({ ...p, rules: [] })],
    ["rules not an array", (p) => ({ ...p, rules: {} })],
    ["nextIndex skips rules", (p) => ({ ...p, nextIndex: p.nextIndex === null ? null : p.nextIndex + 1 })],
    ["nextIndex goes backwards", (p) => ({ ...p, nextIndex: p.nextIndex === null ? null : 0 })],
    ["nextIndex null too early", (p, m) => (m.startIndex === 0 ? { ...p, nextIndex: null } : p)],
    ["nextIndex set at the end", (p) => ({ ...p, nextIndex: p.nextIndex === null ? 5 : p.nextIndex })],
    ["more rules than announced", (p) => (p.nextIndex === null ? { ...p, rules: [...p.rules, p.rules[0]] } : p)],
    ["extra page field", (p) => ({ ...p, cursor: "x" })],
    ["missing nextIndex", (p) => { const { nextIndex, ...rest } = p; return rest; }]
  ];
  for (const [name, change] of cases) {
    test(name + " -> invalid_page, no snapshot", async () => {
      const result = await failure(tamper(nativeHostServing(stateWith(5), { pageSize: 2 }), { page: change }));
      assert.equal(result.error.code, NativeErrorCode.InvalidPage);
      assert.equal(result.state, "INVALID");
      assert.equal("snapshot" in result, false);
    });
  }

  test("duplicate rule ids across pages -> invalid_state", async () => {
    const state = stateWith(4);
    state.rules[3].id = state.rules[0].id;
    const result = await failure(nativeHostServing(state, { pageSize: 2 }));
    assert.equal(result.error.code, NativeErrorCode.InvalidState);
  });

  test("an invalid rule on the last page rejects the whole snapshot", async () => {
    const state = stateWith(6);
    state.rules[5].host = "*.youtube.com";
    assert.equal((await failure(nativeHostServing(state, { pageSize: 2 }))).error.code, NativeErrorCode.InvalidState);
  });

  test("rule with extra metadata is rejected", async () => {
    const state = stateWith(2);
    state.rules[1].serviceEpoch = "abc";
    assert.equal((await failure(nativeHostServing(state))).error.code, NativeErrorCode.InvalidState);
  });

  test("a page larger than the page byte limit -> limit_exceeded", async () => {
    const big = "x".repeat(SnapshotLimits.maxPageBytes);
    const result = await failure(tamper(nativeHostServing(stateWith(2)), { page: (p) => ({ ...p, rules: p.rules.map((r) => ({ ...r, notes: big })) }) }));
    assert.equal(result.error.code, NativeErrorCode.LimitExceeded);
  });

  test("more than 160 pages -> limit_exceeded after exactly 160 page requests", async () => {
    const { runtime, provider: p } = provider(nativeHostServing(stateWith(170), { pageSize: 1 }));
    const result = await p.getSnapshot();
    assert.equal(result.ok, false);
    assert.equal(result.error.code, NativeErrorCode.LimitExceeded);
    assert.equal(runtime.calls.filter((call) => call.message.command === "getStatePage").length, 160);
  });

  test("invalid_cursor from the Service is a host error, not a retry", async () => {
    const serve = nativeHostServing(stateWith(3));
    const { runtime, provider: p } = provider((host, message) =>
      message.command === "getStatePage" ? hostError(message, "invalid_cursor") : serve(host, message));
    const result = await p.getSnapshot();
    assert.equal(result.error.hostErrorCode, "invalid_cursor");
    assert.equal(runtime.calls.length, 3);
    assert.equal(runtime.calls[0].message.command, "ping");
  });
});

describe("NativeStateProvider snapshot changes", () => {
  test("snapshot_changed restarts from a new manifest and succeeds on the second attempt", async () => {
    let revision = 42;
    let pageCalls = 0;
    const { runtime, provider: p } = provider((host, message) => {
      if (message.command === "getStatePage" && ++pageCalls === 2) revision = 43;
      return nativeHostServing(stateWith(4, revision), { pageSize: 2 })(host, message);
    });
    const result = await p.getSnapshot();

    assert.equal(result.ok, true);
    assert.deepEqual(result.identity, { stateGeneration: GEN_A, revision: 43 });
    assert.equal(result.stats.attempts, 2);
    const manifests = runtime.calls.filter((call) => call.message.command === "getStateManifest");
    assert.equal(manifests.length, 2);
    const secondPages = runtime.calls.slice(runtime.calls.indexOf(manifests[1]) + 1);
    assert.ok(secondPages.every((call) => call.message.revision === 43));
  });

  test("a state that changes on every attempt ends with snapshot_unstable after 2 attempts", async () => {
    let revision = 42;
    const { runtime, provider: p } = provider((host, message) => {
      const serve = nativeHostServing(stateWith(4, revision), { pageSize: 2 });
      const outcome = serve(host, message);
      if (message.command === "getStateManifest") revision++;
      return outcome;
    });
    const result = await p.getSnapshot();

    assert.equal(result.ok, false);
    assert.equal(result.error.code, NativeErrorCode.SnapshotUnstable);
    assert.equal(result.error.hostErrorCode, "snapshot_changed");
    assert.equal(result.state, "AVAILABLE");
    assert.equal(result.stats.attempts, 2);
    assert.equal(runtime.calls.filter((call) => call.message.command === "getStateManifest").length, 2);
    assert.equal("snapshot" in result, false);
  });

  test("a generation switch mid-fetch is a snapshot change, never a mixed snapshot", async () => {
    let generation = GEN_A;
    let pageCalls = 0;
    const { provider: p } = provider((host, message) => {
      if (message.command === "getStatePage" && ++pageCalls === 2) generation = GEN_B;
      return nativeHostServing(stateWith(4, 7), { pageSize: 2, generation })(host, message);
    });
    const result = await p.getSnapshot();
    assert.equal(result.ok, true);
    assert.deepEqual(result.identity, { stateGeneration: GEN_B, revision: 7 });
    assert.equal(result.stats.attempts, 2);
  });

  test("snapshot_changed on the manifest is just a host error", async () => {
    const result = await failure((host, message) => hostError(message, "snapshot_changed"));
    assert.equal(result.error.code, NativeErrorCode.HostError);
  });
});

describe("BrowserRoutingSnapshot model", () => {
  const identity = { stateGeneration: GEN_A, revision: 7 };

  test("keeps identity, state and proxy readiness separate", () => {
    const checked = createBrowserRoutingSnapshot({ identity, state: routingState(7), browserProxy: READY });
    assert.equal(checked.ok, true);
    assert.deepEqual(Object.keys(checked.snapshot.state), ["schemaVersion", "revision", "defaultRoute", "rules"]);
    assert.deepEqual(checked.snapshot.identity, identity);
  });

  test("identity revision must equal the state revision", () => {
    const checked = createBrowserRoutingSnapshot({ identity: { ...identity, revision: 8 }, state: routingState(7), browserProxy: READY });
    assert.equal(checked.ok, false);
    assert.equal(checked.error.code, "invalid_snapshot");
  });

  test("rejects non-objects and missing parts", () => {
    for (const input of [null, [], "x", {}, { state: routingState(1) }, { identity, state: routingState(7) },
      { identity: { stateGeneration: "x", revision: 7 }, state: routingState(7), browserProxy: READY }]) {
      assert.equal(createBrowserRoutingSnapshot(input).ok, false);
    }
  });

  test("hostOk helper keeps the envelope exact", () => {
    assert.deepEqual(Object.keys(hostOk({ requestId: "a" }, {}).response), ["protocolVersion", "requestId", "ok", "result"]);
  });
});

describe("NativeStateProvider is read-only", () => {
  test("module source never touches proxy, storage, tabs or polling", async () => {
    const { readFileSync } = await import("node:fs");
    for (const file of ["native-state-provider.js", "snapshot.js"]) {
      const source = readFileSync(new URL("../../src/extension/state/" + file, import.meta.url), "utf8");
      for (const forbidden of ["chrome.proxy", "chrome.storage", "proxy.settings", "setInterval", "connectNative", "chrome.tabs", "localStorage", "getState\""]) {
        assert.equal(source.includes(forbidden), false, file + ": " + forbidden);
      }
    }
  });
});
