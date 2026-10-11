import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadProductVersion } from "../scripts/product-version.js";
import { isChromiumManifestVersion } from "../scripts/slice8-failclosed-fixture.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("product version model maps stable 1.0.0 correctly", () => {
  const model = loadProductVersion();
  assert.equal(model.productVersion, "1.0.0");
  assert.equal(model.releaseChannel, "stable");
  assert.equal(model.releaseRevision, 0);
  assert.equal(model.displayVersion, "1.0.0");
  assert.equal(model.numericVersion, "1.0.0.0");
  assert.equal(model.npmVersion, "1.0.0");
  assert.equal(model.manifestVersion, "1.0.0.0");
  assert.equal(model.manifestVersionName, "1.0.0");
  assert.notEqual(model.productVersion, "1.0.14");
});

test("extension manifest carries numeric and display stable identity", () => {
  const manifest = JSON.parse(readFileSync(path.join(ROOT, "src/extension/manifest.json"), "utf8"));
  const model = loadProductVersion();
  assert.equal(manifest.version, model.manifestVersion);
  assert.equal(manifest.version_name, model.manifestVersionName);
  assert.equal(isChromiumManifestVersion(manifest.version), true);
});

test("package.json uses stable npm mapping", () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.equal(pkg.version, "1.0.0");
});

test("native host props stay in sync with version json", () => {
  const json = loadProductVersion();
  const props = readFileSync(path.join(ROOT, "Directory.Build.props"), "utf8");
  assert.match(props, new RegExp(`<VpnRouteReleaseRevision>${json.releaseRevision}</VpnRouteReleaseRevision>`));
  assert.match(props, new RegExp(`<VpnRouteProductVersion>${json.productVersion}</VpnRouteProductVersion>`));
});

test("protocol versions remain v1 in docs contract", () => {
  const doc = readFileSync(path.join(ROOT, "docs/native-messaging-protocol-v1.md"), "utf8");
  assert.match(doc, /"protocolVersion":\s*1/);
});
