import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DIST_ROOT, PRODUCTION_EXTENSION_ID, ROOT, SPIKE_EXTENSION_ID } from "../../scripts/build-extension.js";
import { buildSlice8FailClosedFixture } from "../../scripts/build-slice8-failclosed-fixture.js";
import {
  SLICE8_FAILCLOSED_FIXTURE_NAME,
  SLICE8_FAILCLOSED_VERSION_NAME,
  createSlice8FailClosedState,
  isChromiumManifestVersion
} from "../../scripts/slice8-failclosed-fixture.js";
import { compilePacScript } from "../../src/pac/index.js";
import { FAIL_CLOSED_BLOCKING_VR_VPN } from "../../src/pac/blocking.js";
import { loadPac, DIRECT } from "../pac/helpers.js";
import { extensionIdFromKey } from "../../scripts/extension-id.js";

describe("Slice8 fail-closed browser fixture", () => {
  test("isChromiumManifestVersion rejects invalid manifest.version strings", () => {
    assert.equal(isChromiumManifestVersion("0.4.0"), true);
    assert.equal(isChromiumManifestVersion("1"), true);
    assert.equal(isChromiumManifestVersion("0.0.1-slice8"), false);
    assert.equal(isChromiumManifestVersion("0.4.0-fixture"), false);
    assert.equal(isChromiumManifestVersion("fixture-0.4.0"), false);
    assert.equal(isChromiumManifestVersion(""), false);
  });

  test("builds isolated unpacked extension with blocking PAC and spike extension ID", async () => {
    const prodManifest = path.join(DIST_ROOT, "extension/manifest.json");
    const prodStatBefore = existsSync(prodManifest) ? statSync(prodManifest).mtimeMs : null;
    const report = await buildSlice8FailClosedFixture();
    if (prodStatBefore !== null) {
      const prodStatAfter = statSync(prodManifest).mtimeMs;
      assert.equal(prodStatBefore, prodStatAfter, "production dist/extension must not be rebuilt");
    }

    assert.equal(report.extensionId, SPIKE_EXTENSION_ID);
    assert.notEqual(report.extensionId, PRODUCTION_EXTENSION_ID);
    assert.equal(report.fixture, SLICE8_FAILCLOSED_FIXTURE_NAME);
    assert.equal(report.ruleCount, 2);
    assert.equal(report.enabledRuleCount, 2);
    assert.equal(report.proxyRoute, FAIL_CLOSED_BLOCKING_VR_VPN);

    const manifest = JSON.parse(readFileSync(path.join(report.outDir, "manifest.json"), "utf8"));
    const productionManifest = JSON.parse(readFileSync(path.join(ROOT, "src/extension/manifest.json"), "utf8"));
    assert.equal(manifest.manifest_version, 3);
    assert.equal(manifest.name, "VPN Route — Slice8 Fail-Closed Fixture");
    assert.equal(manifest.version, productionManifest.version);
    assert.equal(isChromiumManifestVersion(manifest.version), true);
    assert.equal(manifest.version_name, SLICE8_FAILCLOSED_VERSION_NAME);
    assert.deepEqual(manifest.permissions.sort(), ["alarms", "proxy", "storage"]);
    assert.equal(manifest.permissions.includes("nativeMessaging"), false);
    assert.equal(extensionIdFromKey(manifest.key), SPIKE_EXTENSION_ID);

    const source = readFileSync(path.join(report.outDir, "extension/state/source.js"), "utf8");
    assert.match(source, /failClosedBlocking:\s*true/);
    assert.doesNotMatch(source, /nativeMessaging|sendNativeMessage|source-native/);

    const compiled = compilePacScript(createSlice8FailClosedState(), { failClosedBlocking: true });
    assert.match(compiled.script, /var VR_VPN = "SOCKS5 127\.0\.0\.1:0";/);
    const runtime = loadPac(compiled.script);
    assert.equal(runtime.find("api.ipify.org"), FAIL_CLOSED_BLOCKING_VR_VPN);
    assert.equal(runtime.find("example.com"), DIRECT);

    const pacModule = await import(pathToFileURL(path.join(report.outDir, "pac/index.js")).href);
    const built = pacModule.compilePacScript(createSlice8FailClosedState(), { failClosedBlocking: true });
    assert.equal(built.metadata.failClosedBlocking, true);
    assert.match(built.script, /api\.ipify\.org/);
    assert.match(built.script, /example\.com/);
  });
});
