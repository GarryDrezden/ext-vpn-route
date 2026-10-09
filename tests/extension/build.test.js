import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  DIST_ROOT,
  PRODUCTION_EXTENSION_ID,
  ROOT,
  SPIKE_EXTENSION_ID,
  buildExtension,
  validateExtension
} from "../../scripts/build-extension.js";
import { extensionIdFromKey } from "../../scripts/extension-id.js";
import { LARGE_FIXTURE_REVISION, createLargeFixtureState } from "../../scripts/large-fixture.js";
import { validateBrowserRoutingState } from "../../src/domain/browser-routing/index.js";
import { compilePacScript } from "../../src/pac/index.js";
import { SMOKE_STATE } from "../../src/extension/state/smoke-state.js";
import { DIRECT, loadPac } from "../pac/helpers.js";

const TEST_ROOT = path.join(DIST_ROOT, ".test-" + process.pid);
const VPN = "SOCKS5 127.0.0.1:17891";

const EXPECTED_FILES = [
  "domain/browser-routing/constants.js", "domain/browser-routing/host.js", "domain/browser-routing/index.js",
  "domain/browser-routing/issues.js", "domain/browser-routing/matcher.js", "domain/browser-routing/rule.js",
  "domain/browser-routing/state.js",
  "extension/background.js",
  "extension/popup/popup.css", "extension/popup/popup.html", "extension/popup/popup.js",
  "extension/popup/rule-editor-draft.js", "extension/popup/rule-form-helpers.js",
  "extension/popup/rules-labels.js", "extension/popup/rules-ui.js",
  "extension/runtime/chrome-adapter.js", "extension/runtime/config.js", "extension/runtime/proxy-controller.js",
  "extension/runtime/refresh-alarm.js", "extension/runtime/routing-coordinator.js", "extension/runtime/rules-panel.js",
  "extension/state/browser-routing-write-contract.js",
  "extension/state/integration-manifest.js", "extension/state/snapshot.js", "extension/state/vpn-routing-policy.js",
  "extension/state/smoke-state.js", "extension/state/source.js",
  "manifest.json",
  "pac/blocking.js", "pac/compiler.js", "pac/endpoint.js", "pac/index.js", "pac/literal.js", "pac/policy.js", "pac/runtime.js"
].sort();

const EXPECTED_NATIVE_FILES = EXPECTED_FILES
  .filter((file) => file !== "extension/state/smoke-state.js")
  .concat(["extension/state/browser-routing-writer.js", "extension/state/native-state-provider.js"])
  .sort();

let normal;
let large;
let native;

before(async () => {
  normal = await buildExtension({ outDir: path.join(TEST_ROOT, "normal", "extension") });
  large = await buildExtension({ fixture: "large", outDir: path.join(TEST_ROOT, "large", "extension") });
  native = await buildExtension({ mode: "native", outDir: path.join(TEST_ROOT, "native", "extension") });
});

after(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

function copyBuild(name, from = normal) {
  const target = path.join(TEST_ROOT, "tamper-" + name, "extension");
  rmSync(target, { recursive: true, force: true });
  cpSync(from.outDir, target, { recursive: true });
  return target;
}

describe("extension build output", () => {
  test("contains exactly the runtime files", () => {
    assert.deepEqual(normal.files, EXPECTED_FILES);
  });

  test("manifest is MV3 with a module service worker and proxy, storage, alarms", () => {
    const manifest = JSON.parse(readFileSync(path.join(normal.outDir, "manifest.json"), "utf8"));
    assert.equal(manifest.manifest_version, 3);
    assert.deepEqual(manifest.permissions, ["proxy", "storage", "alarms"]);
    assert.deepEqual(manifest.background, { service_worker: "extension/background.js", type: "module" });
    assert.equal(manifest.action.default_popup, "extension/popup/popup.html");
    for (const key of ["host_permissions", "content_scripts", "optional_permissions", "externally_connectable"]) {
      assert.equal(key in manifest, false, key);
    }
  });

  test("production extension ID is stable and differs from the spike", () => {
    const source = JSON.parse(readFileSync(path.join(ROOT, "src/extension/manifest.json"), "utf8"));
    const spike = JSON.parse(readFileSync(path.join(ROOT, "spike/extension/manifest.json"), "utf8"));
    assert.equal(extensionIdFromKey(source.key), PRODUCTION_EXTENSION_ID);
    assert.equal(extensionIdFromKey(spike.key), SPIKE_EXTENSION_ID);
    assert.notEqual(source.key, spike.key);
    assert.equal(normal.extensionId, "lfaekfalhkgmbfdjjlfcalanhijeaien");
    const handoff = readFileSync(path.join(ROOT, "docs/phase3-extension-runtime.md"), "utf8");
    assert.ok(handoff.includes(PRODUCTION_EXTENSION_ID));
  });

  test("source files are copied byte for byte", () => {
    for (const [from, to] of [
      ["src/pac/runtime.js", "pac/runtime.js"],
      ["src/domain/browser-routing/host.js", "domain/browser-routing/host.js"],
      ["src/extension/runtime/proxy-controller.js", "extension/runtime/proxy-controller.js"],
      ["src/extension/state/smoke-state.js", "extension/state/smoke-state.js"]
    ]) {
      assert.equal(readFileSync(path.join(normal.outDir, to), "utf8"), readFileSync(path.join(ROOT, from), "utf8"), to);
    }
  });

  test("every popup element id used by popup.js exists in popup.html", () => {
    const html = readFileSync(path.join(normal.outDir, "extension/popup/popup.html"), "utf8");
    const js = readFileSync(path.join(normal.outDir, "extension/popup/popup.js"), "utf8");
    const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
    const used = [...js.matchAll(/(?:show|byId)\("([a-z-]+)"/g)].map((m) => m[1]);
    assert.ok(used.length > 15);
    for (const id of used) assert.ok(ids.has(id), id);
  });

  test("refuses to clean a directory outside dist/", async () => {
    await assert.rejects(buildExtension({ outDir: path.join(ROOT, "src") }), /Refusing to build outside/);
    await assert.rejects(buildExtension({ outDir: DIST_ROOT }), /Refusing to build outside/);
  });
});

describe("build validation rejects bad output", () => {
  const cases = [
    ["Node import", (dir) => appendTo(dir, "extension/runtime/config.js", "\nimport fs from \"node:fs\";\n"), /node: import/],
    ["require", (dir) => appendTo(dir, "pac/literal.js", "\nconst x = require(\"fs\");\n"), /require\(\)/],
    ["process", (dir) => appendTo(dir, "extension/background.js", "\nif (process.env.X) {}\n"), /process/],
    ["import outside root", (dir) => appendTo(dir, "extension/background.js", "\nimport \"../../../src/pac/index.js\";\n"), /escapes extension root/],
    ["unresolved import", (dir) => appendTo(dir, "extension/background.js", "\nimport { x } from \"./missing.js\";\n"), /unresolved import/],
    ["bare import", (dir) => appendTo(dir, "extension/background.js", "\nimport lodash from \"lodash\";\n"), /non-relative import/],
    ["syntax error", (dir) => appendTo(dir, "pac/policy.js", "\nexport const = ;\n"), /syntax error/],
    ["extra permission", (dir) => editManifest(dir, (m) => { m.permissions.push("tabs"); }), /permissions must be exactly/],
    ["host permissions", (dir) => editManifest(dir, (m) => { m.host_permissions = ["<all_urls>"]; }), /host_permissions/],
    ["classic worker", (dir) => editManifest(dir, (m) => { delete m.background.type; }), /ES module/],
    ["spike key", (dir) => editManifest(dir, (m) => {
      m.key = JSON.parse(readFileSync(path.join(ROOT, "spike/extension/manifest.json"), "utf8")).key;
    }), /extension ID onodojebmdbcndjelgfhoiffeojngmbd/],
    ["stray file", (dir) => writeFileSync(path.join(dir, "notes.txt"), "x"), /unexpected file type/],
    ["remote script", (dir) => appendTo(dir, "extension/popup/popup.html", "<script src=\"https://cdn.example/x.js\"></script>"), /external reference/],
    ["inline script", (dir) => appendTo(dir, "extension/popup/popup.html", "<script>alert(1)</script>"), /inline script/],
    ["polling", (dir) => appendTo(dir, "extension/background.js", "\nsetInterval(() => {}, 1000);\n"), /polling/],
    ["invalid fixture", (dir) => writeFileSync(path.join(dir, "extension/state/smoke-state.js"),
      "export const FIXTURE_NAME = \"normal\";\nexport const SMOKE_STATE = { schemaVersion: 2 };\n"), /Fixture state is invalid/]
  ];

  for (const [name, tamper, expected] of cases) {
    test(name, async () => {
      const dir = copyBuild(name.replace(/\s+/g, "-"));
      tamper(dir);
      await assert.rejects(validateExtension(dir), expected);
    });
  }

  test("an untampered copy validates", async () => {
    await validateExtension(copyBuild("clean"));
  });

  test("fixture build rejects native messaging code and permission", async () => {
    let dir = copyBuild("fixture-native-call");
    appendTo(dir, "extension/background.js", "\nchrome.runtime.sendNativeMessage(\"x\", {}, () => {});\n");
    await assert.rejects(validateExtension(dir), /native messaging is allowed only/);

    dir = copyBuild("fixture-native-permission");
    editManifest(dir, (m) => { m.permissions.push("nativeMessaging"); });
    await assert.rejects(validateExtension(dir, { expectMode: "fixture" }), /permissions must be exactly alarms, proxy, storage/);

    dir = copyBuild("fixture-native-file");
    cpSync(path.join(ROOT, "src/extension/state/native-state-provider.js"), path.join(dir, "extension/state/native-state-provider.js"));
    await assert.rejects(validateExtension(dir, { expectMode: "fixture" }), /must not contain extension\/state\/native-state-provider\.js/);
  });
});

describe("native build", () => {
  test("contains the native provider and no fixture", () => {
    assert.deepEqual(native.files, EXPECTED_NATIVE_FILES);
    assert.equal(native.mode, "native");
    assert.equal(native.fixture, null);
    assert.equal(native.hostName, "com.vpnroute.browser");
    assert.equal(native.extensionId, PRODUCTION_EXTENSION_ID);
    for (const file of native.files.filter((f) => f.endsWith(".js"))) {
      const text = readFileSync(path.join(native.outDir, file), "utf8");
      assert.equal(text.includes("smoke-state"), false, file);
      assert.equal(text.includes("SMOKE_STATE"), false, file);
    }
  });

  test("manifest adds nativeMessaging and alarms", () => {
    const manifest = JSON.parse(readFileSync(path.join(native.outDir, "manifest.json"), "utf8"));
    assert.deepEqual(manifest.permissions, ["nativeMessaging", "proxy", "storage", "alarms"]);
    for (const key of ["host_permissions", "content_scripts", "optional_permissions", "externally_connectable"]) {
      assert.equal(key in manifest, false, key);
    }
  });

  test("state source module is the native one", () => {
    assert.equal(
      readFileSync(path.join(native.outDir, "extension/state/source.js"), "utf8"),
      readFileSync(path.join(ROOT, "src/extension/state/source-native.js"), "utf8"));
  });

  test("native build cannot take a fixture", async () => {
    await assert.rejects(buildExtension({ mode: "native", fixture: "large", outDir: path.join(TEST_ROOT, "x", "extension") }),
      /native build has no fixture/);
    await assert.rejects(buildExtension({ mode: "socket", outDir: path.join(TEST_ROOT, "x", "extension") }), /Unknown mode/);
  });

  const nativeCases = [
    ["fixture smuggled in", (dir) => cpSync(path.join(ROOT, "src/extension/state/smoke-state.js"),
      path.join(dir, "extension/state/smoke-state.js")), /must not contain extension\/state\/smoke-state\.js/],
    ["fixture import", (dir) => appendTo(dir, "extension/background.js", "\n// ./state/smoke-state.js\n"), /references the fixture/],
    ["connectNative", (dir) => appendTo(dir, "extension/state/native-state-provider.js", "\nchrome.runtime.connectNative(\"x\");\n"),
      /long-lived native port/],
    ["native call elsewhere", (dir) => appendTo(dir, "extension/background.js", "\nchrome.runtime.sendNativeMessage(\"x\", {});\n"),
      /native messaging is allowed only/],
    ["extra permission", (dir) => editManifest(dir, (m) => { m.permissions.push("tabs"); }), /permissions must be exactly/],
    ["missing nativeMessaging", (dir) => editManifest(dir, (m) => { m.permissions = ["proxy", "storage", "alarms"]; }),
      /permissions must be exactly alarms, nativeMessaging, proxy, storage/],
    ["host name", (dir) => {
      const full = path.join(dir, "extension/runtime/config.js");
      writeFileSync(full, readFileSync(full, "utf8").replace("com.vpnroute.browser", "com.vpnroute.phase0b"));
    }, /Native host name is not com\.vpnroute\.browser/],
    ["fixture source", (dir) => cpSync(path.join(ROOT, "src/extension/state/source.js"), path.join(dir, "extension/state/source.js")),
      /references the fixture|State source is Fixture/]
  ];

  for (const [name, tamper, expected] of nativeCases) {
    test("rejects " + name, async () => {
      const dir = copyBuild("native-" + name.replace(/\s+/g, "-"), native);
      tamper(dir);
      await assert.rejects(validateExtension(dir), expected);
    });
  }

  test("an untampered native copy validates", async () => {
    const report = await validateExtension(copyBuild("native-clean", native));
    assert.equal(report.mode, "native");
  });
});

function appendTo(dir, file, text) {
  const full = path.join(dir, file);
  writeFileSync(full, readFileSync(full, "utf8") + text);
}

function editManifest(dir, edit) {
  const full = path.join(dir, "manifest.json");
  const manifest = JSON.parse(readFileSync(full, "utf8"));
  edit(manifest);
  writeFileSync(full, JSON.stringify(manifest, null, 2));
}

describe("fixtures", () => {
  test("normal smoke state is valid and routes the acceptance sites", () => {
    assert.equal(validateBrowserRoutingState(SMOKE_STATE).ok, true);
    assert.equal(normal.fixture, "normal");
    assert.equal(normal.revision, 3001);
    assert.equal(normal.enabledRuleCount, 3);
    const pac = loadPac(compilePacScript(SMOKE_STATE, { proxyPort: 17891 }).script);
    assert.equal(pac.find("www.youtube.com"), VPN);
    assert.equal(pac.find("rr1---sn-abc.googlevideo.com"), VPN);
    assert.equal(pac.find("example.com"), DIRECT);
    assert.equal(pac.find("www.example.com"), DIRECT);
    assert.equal(pac.find("ya.ru"), DIRECT);
  });

  test("large fixture is deterministic, valid and about 10000 rules", () => {
    const a = createLargeFixtureState();
    assert.deepEqual(createLargeFixtureState(), a);
    assert.equal(a.rules.length, 10000);
    assert.equal(a.revision, LARGE_FIXTURE_REVISION);
    assert.equal(validateBrowserRoutingState(a).ok, true);
    assert.equal(large.fixture, "large");
    assert.equal(large.revision, 3999);
    assert.equal(large.enabledRuleCount, 10000);
    assert.ok(large.pacBytes > 300000 && large.pacBytes < 500000, String(large.pacBytes));
  });

  test("large build routes the same acceptance sites as the normal one", async () => {
    const { SMOKE_STATE: built } = await import(pathToFileURL(path.join(large.outDir, "extension/state/smoke-state.js")).href);
    const pac = loadPac(compilePacScript(built, { proxyPort: 17891 }).script);
    assert.equal(pac.find("www.youtube.com"), VPN);
    assert.equal(pac.find("example.com"), DIRECT);
    assert.equal(pac.find("x.s1.z1.large.vpnroute.test"), VPN);
    assert.equal(pac.find("x.s4.z4.large.vpnroute.test"), DIRECT);
    assert.equal(pac.find("s0.z0.large.vpnroute.test"), VPN);
    assert.equal(pac.find("x.s0.z0.large.vpnroute.test"), DIRECT);
  });

  test("large fixture is generated only at build time", () => {
    assert.equal(readFileSync(path.join(normal.outDir, "extension/state/smoke-state.js"), "utf8")
      .includes("large.vpnroute.test"), false);
    for (const file of normal.files.filter((f) => f.endsWith(".js"))) {
      assert.equal(readFileSync(path.join(normal.outDir, file), "utf8").includes("createLargeFixtureState"), false, file);
    }
  });
});
