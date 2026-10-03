import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_NATIVE_TIMEOUT_MS,
  NativeErrorCode,
  createNativeStateProvider
} from "../../src/extension/state/native-state-provider.js";
import { createBrowserRoutingSnapshot } from "../../src/extension/state/snapshot.js";
import { NATIVE_HOST_NAME } from "../../src/extension/runtime/config.js";
import { createFakeNativeRuntime, fakeNow, nativeHostFailing, nativeHostReturning, routingState } from "./fakes.js";

let counter = 0;
function provider(handler, extra = {}) {
  const runtime = createFakeNativeRuntime(handler);
  const instance = createNativeStateProvider({
    runtime,
    hostName: NATIVE_HOST_NAME,
    newRequestId: () => "req-" + ++counter,
    now: fakeNow,
    ...extra
  });
  return { runtime, provider: instance };
}

function respond(response) {
  return () => ({ response });
}

async function failure(handler, extra) {
  const result = await provider(handler, extra).provider.getState();
  assert.equal(result.ok, false);
  return result;
}

describe("NativeStateProvider request", () => {
  test("sends one declarative getState request to com.vpnroute.browser", async () => {
    const { runtime, provider: p } = provider(nativeHostReturning(routingState(42)));
    const result = await p.getState();

    assert.equal(result.ok, true);
    assert.equal(runtime.calls.length, 1);
    assert.equal(runtime.calls[0].hostName, "com.vpnroute.browser");
    assert.deepEqual(Object.keys(runtime.calls[0].message), ["protocolVersion", "requestId", "command"]);
    assert.equal(runtime.calls[0].message.protocolVersion, 1);
    assert.equal(runtime.calls[0].message.command, "getState");
    assert.equal(result.requestId, runtime.calls[0].message.requestId);
  });

  test("returns a frozen canonical snapshot", async () => {
    const state = routingState(42);
    state.rules[0].host = "YouTube.COM.";
    const result = await provider(nativeHostReturning(state)).provider.getState();

    assert.equal(result.ok, true);
    assert.equal(result.transport, "AVAILABLE");
    assert.equal(result.service, "AVAILABLE");
    assert.equal(result.snapshot.state.revision, 42);
    assert.equal(result.snapshot.state.rules[0].host, "youtube.com");
    assert.deepEqual(result.snapshot.proxyEndpoint, { host: "127.0.0.1", port: 17891 });
    assert.ok(Object.isFrozen(result.snapshot));
    assert.deepEqual(Object.keys(result.snapshot), ["state", "proxyEndpoint"]);
  });

  test("each call uses a fresh request id", async () => {
    const { runtime, provider: p } = provider(nativeHostReturning(routingState(1)));
    await p.getState();
    await p.getState();
    assert.notEqual(runtime.calls[0].message.requestId, runtime.calls[1].message.requestId);
  });

  test("default request id is a UUID", async () => {
    const runtime = createFakeNativeRuntime(nativeHostReturning(routingState(1)));
    const p = createNativeStateProvider({ runtime, hostName: NATIVE_HOST_NAME });
    const result = await p.getState();
    assert.match(result.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  test("rejects invalid host names and a missing API at construction", () => {
    const runtime = createFakeNativeRuntime(() => ({}));
    for (const hostName of ["", "com.vpnroute.*", "COM.VPN", "../evil", "a..b", 7]) {
      assert.throws(() => createNativeStateProvider({ runtime, hostName }), /Invalid native messaging host name/);
    }
    assert.throws(() => createNativeStateProvider({ runtime: {}, hostName: NATIVE_HOST_NAME }), /not available/);
  });

  test("default timeout is 5 seconds", () => {
    assert.equal(DEFAULT_NATIVE_TIMEOUT_MS, 5000);
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
      assert.equal(result.error.message, message);
    });
  }

  test("timeout", async () => {
    const result = await failure(() => ({ hang: true }), { timeoutMs: 20 });
    assert.equal(result.error.code, NativeErrorCode.Timeout);
    assert.equal(result.transport, "ERROR");
  });

  test("a late response after the timeout is ignored", async () => {
    let late;
    const runtime = {
      lastError: undefined,
      sendNativeMessage: (host, message, callback) => { late = () => callback({ protocolVersion: 1, requestId: message.requestId, ok: true, result: {} }); }
    };
    const p = createNativeStateProvider({ runtime, hostName: NATIVE_HOST_NAME, timeoutMs: 10 });
    const result = await p.getState();
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
});

describe("NativeStateProvider envelope validation", () => {
  const ok = (requestId, extra = {}) => ({
    protocolVersion: 1, requestId, ok: true,
    result: { state: routingState(5), proxyEndpoint: { host: "127.0.0.1", port: 17891 } },
    ...extra
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
      const result = await failure(respond(response));
      assert.equal(result.error.code, NativeErrorCode.MalformedResponse);
      assert.equal(result.transport, "ERROR");
    });
  }

  test("malformed: extra envelope field", async () => {
    const result = await failure((host, message) => ({ response: ok(message.requestId, { debug: "x" }) }));
    assert.equal(result.error.code, NativeErrorCode.MalformedResponse);
  });

  test("malformed: success with error field", async () => {
    const result = await failure((host, message) => ({ response: ok(message.requestId, { error: { code: "x", message: "y" } }) }));
    assert.equal(result.error.code, NativeErrorCode.MalformedResponse);
  });

  for (const version of [0, 2, "1", null, undefined]) {
    test("unsupported protocolVersion " + String(version), async () => {
      const result = await failure((host, message) => ({ response: { ...ok(message.requestId), protocolVersion: version } }));
      assert.equal(result.error.code, NativeErrorCode.UnsupportedProtocol);
    });
  }

  test("mismatched requestId on success", async () => {
    const result = await failure(() => ({ response: ok("someone-else") }));
    assert.equal(result.error.code, NativeErrorCode.RequestIdMismatch);
  });

  test("null requestId on success", async () => {
    const result = await failure(() => ({ response: ok(null) }));
    assert.equal(result.error.code, NativeErrorCode.RequestIdMismatch);
  });

  test("mismatched requestId on error", async () => {
    const result = await failure(() => ({
      response: { protocolVersion: 1, requestId: "other", ok: false, error: { code: "service_unavailable", message: "m" } }
    }));
    assert.equal(result.error.code, NativeErrorCode.RequestIdMismatch);
  });

  test("ok:false service_unavailable -> host_error, Service UNAVAILABLE, transport AVAILABLE", async () => {
    const result = await failure(nativeHostFailing("service_unavailable", "VPN Route Service is unavailable."));
    assert.equal(result.error.code, NativeErrorCode.HostError);
    assert.equal(result.error.hostErrorCode, "service_unavailable");
    assert.equal(result.transport, "AVAILABLE");
    assert.equal(result.service, "UNAVAILABLE");
  });

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

describe("NativeStateProvider result validation", () => {
  test("invalid state (Phase 1 validation)", async () => {
    const result = await failure(nativeHostReturning({ schemaVersion: 2, revision: 1, defaultRoute: "Direct", rules: [] }));
    assert.equal(result.error.code, NativeErrorCode.InvalidState);
    assert.equal(result.transport, "AVAILABLE");
    assert.equal(result.service, "AVAILABLE");
  });

  test("invalid rule inside state", async () => {
    const state = routingState(1);
    state.rules[0].host = "*.youtube.com";
    assert.equal((await failure(nativeHostReturning(state))).error.code, NativeErrorCode.InvalidState);
  });

  test("state with BrowserRoutingState extra metadata is rejected", async () => {
    assert.equal((await failure(nativeHostReturning(routingState(1, { serviceEpoch: "abc" })))).error.code, NativeErrorCode.InvalidState);
  });

  const endpoints = [
    ["remote IPv4", { host: "192.168.1.10", port: 17891 }],
    ["wildcard bind address", { host: "0.0.0.0", port: 17891 }],
    ["hostname", { host: "localhost", port: 17891 }],
    ["public host", { host: "proxy.example.com", port: 1080 }],
    ["IPv6", { host: "::1", port: 17891 }],
    ["port 0", { host: "127.0.0.1", port: 0 }],
    ["port string", { host: "127.0.0.1", port: "17891" }],
    ["port too big", { host: "127.0.0.1", port: 70000 }]
  ];
  for (const [name, endpoint] of endpoints) {
    test("invalid endpoint: " + name, async () => {
      assert.equal((await failure(nativeHostReturning(routingState(1), endpoint))).error.code, NativeErrorCode.InvalidEndpoint);
    });
  }

  test("endpoint without host is rejected (no silent default)", async () => {
    assert.equal((await failure(nativeHostReturning(routingState(1), { port: 17891 }))).error.code, NativeErrorCode.InvalidEndpoint);
  });

  test("endpoint with extra fields is rejected", async () => {
    const endpoint = { host: "127.0.0.1", port: 17891, scheme: "http" };
    assert.equal((await failure(nativeHostReturning(routingState(1), endpoint))).error.code, NativeErrorCode.InvalidEndpoint);
  });

  test("result with extra fields is rejected", async () => {
    const result = await failure((host, message) => ({
      response: {
        protocolVersion: 1, requestId: message.requestId, ok: true,
        result: { state: routingState(1), proxyEndpoint: { host: "127.0.0.1", port: 1 }, serviceVersion: "x" }
      }
    }));
    assert.equal(result.error.code, NativeErrorCode.InvalidSnapshot);
  });

  test("other loopback addresses are accepted", async () => {
    const result = await provider(nativeHostReturning(routingState(1), { host: "127.10.0.2", port: 1080 })).provider.getState();
    assert.equal(result.ok, true);
    assert.deepEqual(result.snapshot.proxyEndpoint, { host: "127.10.0.2", port: 1080 });
  });
});

describe("BrowserRoutingSnapshot model", () => {
  test("keeps state and endpoint separate", () => {
    const checked = createBrowserRoutingSnapshot({ state: routingState(7), proxyEndpoint: { host: "127.0.0.1", port: 17891 } });
    assert.equal(checked.ok, true);
    assert.equal("proxyEndpoint" in checked.snapshot.state, false);
    assert.deepEqual(Object.keys(checked.snapshot.state), ["schemaVersion", "revision", "defaultRoute", "rules"]);
  });

  test("rejects non-objects and missing parts", () => {
    for (const input of [null, [], "x", {}, { state: routingState(1) }, { proxyEndpoint: { host: "127.0.0.1", port: 1 } }]) {
      assert.equal(createBrowserRoutingSnapshot(input).ok, false);
    }
  });
});

describe("NativeStateProvider is read-only", () => {
  test("module source never touches proxy, storage, tabs or polling", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("../../src/extension/state/native-state-provider.js", import.meta.url), "utf8");
    for (const forbidden of ["chrome.proxy", "chrome.storage", "proxy.settings", "setInterval", "connectNative", "chrome.tabs", "localStorage"]) {
      assert.equal(source.includes(forbidden), false, forbidden);
    }
  });
});
