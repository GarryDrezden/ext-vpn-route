import { describe, test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { compilePacScript, FAIL_CLOSED_BLOCKING_VR_VPN } from "../../src/pac/index.js";
import { MatchType, RouteMode } from "../../src/domain/browser-routing/constants.js";
import { DIRECT, loadPac } from "./helpers.js";

const LEGACY_SENTINEL_PORT = 41999;

function vpnYoutubeState() {
  return {
    schemaVersion: 1,
    revision: 1,
    defaultRoute: "Direct",
    rules: [{
      id: "yt", name: "YouTube", host: "youtube.com", matchType: MatchType.DomainAndSubdomains,
      routeMode: RouteMode.VPN, enabled: true, source: "User", notes: null
    }]
  };
}

describe("fail-closed blocking PAC route", () => {
  test("failClosedBlocking emits invalid Chromium SOCKS port 0, not DIRECT", () => {
    const result = compilePacScript(vpnYoutubeState(), { failClosedBlocking: true });
    assert.equal(result.ok, true);
    assert.equal(result.metadata.failClosedBlocking, true);
    assert.equal(result.metadata.proxyRoute, FAIL_CLOSED_BLOCKING_VR_VPN);
    assert.match(result.script, /var VR_VPN = "SOCKS5 127\.0\.0\.1:0";/);
    assert.doesNotMatch(result.script, /; DIRECT/);
    const route = loadPac(result.script).find("youtube.com");
    assert.equal(route, FAIL_CLOSED_BLOCKING_VR_VPN);
    assert.notEqual(route, DIRECT);
    const direct = loadPac(result.script).find("example.com");
    assert.equal(direct, DIRECT);
  });

  test("legacy fixed port 41999 is bindable and PAC targets that listener", async () => {
    const server = net.createServer();
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(LEGACY_SENTINEL_PORT, "127.0.0.1", resolve);
    });
    try {
      const result = compilePacScript(vpnYoutubeState(), { proxyPort: LEGACY_SENTINEL_PORT });
      assert.equal(result.ok, true);
      const route = loadPac(result.script).find("youtube.com");
      assert.equal(route, "SOCKS5 127.0.0.1:" + LEGACY_SENTINEL_PORT);
      assert.equal(server.listening, true);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test("blocking route :0 is not satisfied by a listener on legacy sentinel port", async () => {
    const server = net.createServer();
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(LEGACY_SENTINEL_PORT, "127.0.0.1", resolve);
    });
    try {
      const result = compilePacScript(vpnYoutubeState(), { failClosedBlocking: true });
      const route = loadPac(result.script).find("youtube.com");
      assert.equal(route, FAIL_CLOSED_BLOCKING_VR_VPN);
      assert.notEqual(route, "SOCKS5 127.0.0.1:" + LEGACY_SENTINEL_PORT);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe("Chromium invalid proxy resolution", () => {
  test("end-to-end connection failure with mandatory PAC is Slice 8 manual acceptance", () => {
    assert.equal(FAIL_CLOSED_BLOCKING_VR_VPN, "SOCKS5 127.0.0.1:0");
  });
});
