// Dependency-free build of the unpacked MV3 extension.
//
// dist/extension/ mirrors src/ so relative ES module imports work unchanged:
//   manifest.json              <- src/extension/manifest.json
//   extension/**               <- src/extension/** (without manifest.json)
//   pac/*.js                   <- src/pac/*.js
//   domain/browser-routing/*.js <- src/domain/browser-routing/*.js
//
// The state source is fixed at build time:
//   --mode=fixture (default)  build-time fixture, permissions proxy + storage, no native messaging code;
//   --mode=native             extension/state/source.js <- source-native.js, adds nativeMessaging,
//                             contains no fixture module.
//
// Usage: node scripts/build-extension.js [--mode=fixture|native] [--fixture=normal|large] [--out=<dir inside dist/>]

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { extensionIdFromKey } from "./extension-id.js";
import { createLargeFixtureState, renderFixtureModule } from "./large-fixture.js";
import {
  SLICE8_FAILCLOSED_FIXTURE_NAME,
  SLICE8_FAILCLOSED_VERSION_NAME,
  isChromiumManifestVersion,
  renderSlice8FailClosedSmokeModule
} from "./slice8-failclosed-fixture.js";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DIST_ROOT = path.join(ROOT, "dist");
export const DEFAULT_OUT = path.join(DIST_ROOT, "extension");
export const PRODUCTION_EXTENSION_ID = "lfaekfalhkgmbfdjjlfcalanhijeaien";
export const SPIKE_EXTENSION_ID = "onodojebmdbcndjelgfhoiffeojngmbd";
export const FIXTURES = Object.freeze(["normal", "large", "slice8-failclosed"]);
export const ARTIFACTS_ROOT = path.join(ROOT, "artifacts");
export const MODES = Object.freeze(["fixture", "native"]);
export const NATIVE_HOST_NAME = "com.vpnroute.browser";

const NATIVE_ONLY_FILES = Object.freeze([
  "state/source-native.js", "state/native-state-provider.js", "state/browser-routing-writer.js"
]);
const FIXTURE_SKIP_FILES = Object.freeze(["runtime/native-push-manager.js"]);
const FIXTURE_ONLY_FILES = Object.freeze(["state/smoke-state.js", "state/source.js"]);
const NATIVE_MESSAGING_FILES = Object.freeze([
  "extension/state/native-state-provider.js",
  "extension/state/browser-routing-writer.js"
]);
const NATIVE_CONNECT_FILES = Object.freeze([
  "extension/runtime/native-push-manager.js"
]);

const SOURCES = Object.freeze({
  fixture: Object.freeze([
    {
      from: "src/extension",
      to: "extension",
      skip: ["manifest.json", ...NATIVE_ONLY_FILES, ...FIXTURE_SKIP_FILES, "state/source-slice8-failclosed.js"]
    },
    { from: "src/pac", to: "pac" },
    { from: "src/domain/browser-routing", to: "domain/browser-routing" }
  ]),
  native: Object.freeze([
    {
      from: "src/extension",
      to: "extension",
      skip: ["manifest.json", "state/source-native.js", "state/source-slice8-failclosed.js", ...FIXTURE_ONLY_FILES],
      rename: { "state/source-native.js": "state/source.js" }
    },
    { from: "src/pac", to: "pac" },
    { from: "src/domain/browser-routing", to: "domain/browser-routing" }
  ])
});
const ALLOWED_EXTENSIONS = Object.freeze([".js", ".json", ".html", ".css"]);
const PERMISSIONS = Object.freeze({
  fixture: Object.freeze(["proxy", "storage", "alarms"]),
  native: Object.freeze(["nativeMessaging", "proxy", "storage", "alarms"])
});
const ALARMS_ALLOWED_FILES = Object.freeze([
  "extension/runtime/refresh-alarm.js"
]);
const FORBIDDEN_MANIFEST_KEYS = Object.freeze([
  "host_permissions", "optional_permissions", "optional_host_permissions", "content_scripts",
  "externally_connectable", "web_accessible_resources", "content_security_policy", "update_url"
]);
const FORBIDDEN_CODE = Object.freeze([
  [/\brequire\s*\(/, "require()"],
  [/from\s*["']node:/, "node: import"],
  [/from\s*["'](?:fs|path|os|child_process|crypto|url|vm|net|http|https)["']/, "Node core import"],
  [/\bprocess\./, "process"],
  [/\bBuffer\b/, "Buffer"],
  [/\b__dirname\b|\b__filename\b/, "__dirname/__filename"],
  [/\bmodule\.exports\b|\bexports\./, "CommonJS exports"],
  [/\bimport\s*\(/, "dynamic import"],
  [/\beval\s*\(/, "eval"],
  [/new\s+Function\b/, "new Function"],
  [/\bfetch\s*\(/, "fetch"],
  [/\bXMLHttpRequest\b/, "XMLHttpRequest"],
  [/\bWebSocket\b/, "WebSocket"],
  [/\bimportScripts\b/, "importScripts"],
  [/\bsetInterval\s*\(/, "setInterval polling"],
  [/\bchrome\.alarms\b/, "chrome.alarms polling"],
  [/\bchrome\.tabs\b/, "chrome.tabs"],
  [/\bchrome\.history\b/, "chrome.history"],
  [/\bchrome\.webRequest\b/, "chrome.webRequest"],
  [/\bchrome\.scripting\b/, "chrome.scripting"],
  [/https?:\/\/[a-z0-9]/i, "remote URL"]
]);
const NATIVE_MESSAGING_CODE = /\bsendNativeMessage\b|\bnativeMessaging\b/;

function assertSafeOut(outDir) {
  const resolved = path.resolve(outDir);
  for (const root of [DIST_ROOT, ARTIFACTS_ROOT]) {
    const relative = path.relative(root, resolved);
    if (relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)) {
      return resolved;
    }
  }
  throw new Error("Refusing to build outside " + DIST_ROOT + " or " + ARTIFACTS_ROOT + ": " + resolved);
}

function walk(dir, base = dir) {
  const files = [];
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) files.push(...walk(full, base));
    else files.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return files;
}

function copyFile(from, to) {
  mkdirSync(path.dirname(to), { recursive: true });
  cpSync(from, to);
}

/**
 * @param {{ mode?: "fixture" | "native", fixture?: "normal" | "large", outDir?: string }} [options]
 */
export async function buildExtension(options = {}) {
  const mode = options.mode || "fixture";
  if (!MODES.includes(mode)) throw new Error("Unknown mode " + mode);
  if (mode === "native" && options.fixture) throw new Error("A native build has no fixture");
  const fixture = mode === "fixture" ? options.fixture || "normal" : null;
  if (mode === "fixture" && !FIXTURES.includes(fixture)) throw new Error("Unknown fixture " + fixture);
  const outDir = assertSafeOut(options.outDir || DEFAULT_OUT);

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const manifest = JSON.parse(readFileSync(path.join(ROOT, "src/extension/manifest.json"), "utf8"));
  manifest.permissions = [...PERMISSIONS[mode]];
  writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");

  for (const source of SOURCES[mode]) {
    const fromDir = path.join(ROOT, source.from);
    for (const file of walk(fromDir)) {
      const renamed = source.rename && source.rename[file];
      if (renamed) copyFile(path.join(fromDir, file), path.join(outDir, source.to, renamed));
      if (source.skip && source.skip.includes(file)) continue;
      copyFile(path.join(fromDir, file), path.join(outDir, source.to, file));
    }
  }
  if (fixture === "large") {
    writeFileSync(path.join(outDir, "extension/state/smoke-state.js"),
      renderFixtureModule("large", createLargeFixtureState()), "utf8");
  }
  if (mode === "fixture") {
    writeFileSync(
      path.join(outDir, "extension/runtime/native-push-manager.js"),
      "// Fixture build: push sync is native-only.\nexport function wireNativePushManager() { return null; }\n",
      "utf8"
    );
  }
  if (fixture === SLICE8_FAILCLOSED_FIXTURE_NAME) {
    writeFileSync(path.join(outDir, "extension/state/smoke-state.js"), renderSlice8FailClosedSmokeModule(), "utf8");
    copyFile(
      path.join(ROOT, "src/extension/state/source-slice8-failclosed.js"),
      path.join(outDir, "extension/state/source.js")
    );
    const spikeManifest = JSON.parse(readFileSync(path.join(ROOT, "spike/extension/manifest.json"), "utf8"));
    manifest.name = "VPN Route — Slice8 Fail-Closed Fixture";
    manifest.description =
      "Temporary browser acceptance: mandatory blocking PAC (SOCKS5 127.0.0.1:0). Disable production VPN Route while testing.";
    manifest.version_name = SLICE8_FAILCLOSED_VERSION_NAME;
    manifest.key = spikeManifest.key;
    writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
  }

  return validateExtension(outDir, { expectMode: mode, expectFixture: fixture });
}

function importSpecifiers(source) {
  const specifiers = [];
  const patterns = [
    /^\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/gm,
    /^\s*import\s*["']([^"']+)["']/gm
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.push(match[1]);
  }
  return specifiers;
}

function insideRoot(root, target) {
  const relative = path.relative(root, target);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * Validates a built extension directory. Throws on the first category of problems found.
 *
 * @param {string} outDir
 * @param {{ expectMode?: "fixture" | "native", expectFixture?: string | null }} [options]
 */
export async function validateExtension(outDir, options = {}) {
  const problems = [];
  const files = walk(outDir);
  const mode = options.expectMode || (files.some((f) => NATIVE_MESSAGING_FILES.includes(f)) ? "native" : "fixture");
  if (!MODES.includes(mode)) throw new Error("Unknown mode " + mode);

  const mustBeAbsent = mode === "native"
    ? ["extension/state/smoke-state.js", "extension/state/source-native.js"]
    : NATIVE_ONLY_FILES.map((file) => "extension/" + file);
  for (const file of mustBeAbsent) {
    if (files.includes(file)) problems.push(mode + " build must not contain " + file);
  }
  if (!files.includes("extension/state/source.js")) problems.push("missing extension/state/source.js");

  for (const file of files) {
    if (!ALLOWED_EXTENSIONS.includes(path.extname(file))) problems.push("unexpected file type: " + file);
  }
  for (const banned of ["tests/", "docs/", "spike/", "scripts/", ".git", "node_modules/", "package.json"]) {
    if (files.some((file) => file === banned || file.startsWith(banned) || file.includes("/" + banned))) {
      problems.push("build contains " + banned);
    }
  }

  const manifest = JSON.parse(readFileSync(path.join(outDir, "manifest.json"), "utf8"));
  if (manifest.manifest_version !== 3) problems.push("manifest_version must be 3");
  if (typeof manifest.name !== "string" || typeof manifest.version !== "string") problems.push("manifest name/version missing");
  if (!isChromiumManifestVersion(manifest.version)) {
    problems.push("manifest.version is not Chromium-compatible: " + manifest.version);
  }
  if (options.expectFixture === SLICE8_FAILCLOSED_FIXTURE_NAME) {
    if (manifest.version_name !== SLICE8_FAILCLOSED_VERSION_NAME) {
      problems.push("slice8-failclosed fixture must set version_name to " + SLICE8_FAILCLOSED_VERSION_NAME);
    }
  }
  const permissions = Array.isArray(manifest.permissions) ? [...manifest.permissions].sort() : [];
  const expectedPermissions = [...PERMISSIONS[mode]].sort();
  if (JSON.stringify(permissions) !== JSON.stringify(expectedPermissions)) {
    problems.push("permissions must be exactly " + expectedPermissions.join(", ") + "; got " + permissions.join(", "));
  }
  for (const key of FORBIDDEN_MANIFEST_KEYS) {
    if (key in manifest) problems.push("manifest must not declare " + key);
  }
  const background = manifest.background || {};
  if (background.type !== "module") problems.push("service worker must be an ES module");
  for (const ref of [background.service_worker, manifest.action && manifest.action.default_popup]) {
    if (typeof ref !== "string" || !existsSync(path.join(outDir, ref))) problems.push("manifest reference missing: " + ref);
  }
  if (typeof manifest.key !== "string") problems.push("manifest key missing");
  const extensionId = typeof manifest.key === "string" ? extensionIdFromKey(manifest.key) : null;
  const expectedExtensionId = options.expectFixture === SLICE8_FAILCLOSED_FIXTURE_NAME
    ? SPIKE_EXTENSION_ID
    : PRODUCTION_EXTENSION_ID;
  if (extensionId !== expectedExtensionId) {
    problems.push("extension ID " + extensionId + " is not " + expectedExtensionId);
  }

  const jsFiles = files.filter((file) => file.endsWith(".js"));
  for (const file of jsFiles) {
    const full = path.join(outDir, file);
    const source = readFileSync(full, "utf8");
    for (const specifier of importSpecifiers(source)) {
      if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
        problems.push(file + ": non-relative import " + specifier);
        continue;
      }
      const target = path.resolve(path.dirname(full), specifier);
      if (!insideRoot(outDir, target)) problems.push(file + ": import escapes extension root " + specifier);
      else if (!existsSync(target)) problems.push(file + ": unresolved import " + specifier);
    }
    for (const [pattern, label] of FORBIDDEN_CODE) {
      if (label === "chrome.alarms polling" && ALARMS_ALLOWED_FILES.includes(file)) continue;
      if (pattern.test(source)) problems.push(file + ": forbidden " + label);
    }
    if (/\bconnectNative\b/.test(source) && !(mode === "native" && NATIVE_CONNECT_FILES.includes(file))) {
      problems.push(file + ": connectNative is allowed only in " + NATIVE_CONNECT_FILES.join(" or ") + " of a native build");
    }
    if (NATIVE_MESSAGING_CODE.test(source) && !(mode === "native" && NATIVE_MESSAGING_FILES.includes(file))) {
      problems.push(file + ": native messaging is allowed only in " + NATIVE_MESSAGING_FILES.join(" or ") + " of a native build");
    }
    if (mode === "native" && /smoke-state/.test(source)) problems.push(file + ": native build references the fixture");
    try {
      execFileSync(process.execPath, ["--check", full], { stdio: "pipe" });
    } catch (error) {
      problems.push(file + ": syntax error " + String(error.stderr || error.message).split("\n").slice(0, 4).join(" "));
    }
  }

  for (const file of files.filter((name) => name.endsWith(".html"))) {
    const html = readFileSync(path.join(outDir, file), "utf8");
    if (/<script(?![^>]*\bsrc=)[^>]*>/i.test(html)) problems.push(file + ": inline script");
    if (/\bon[a-z]+\s*=/i.test(html)) problems.push(file + ": inline event handler");
    for (const match of html.matchAll(/\b(?:src|href)\s*=\s*"([^"]+)"/g)) {
      const target = path.resolve(path.dirname(path.join(outDir, file)), match[1]);
      if (/^[a-z]+:/i.test(match[1])) problems.push(file + ": external reference " + match[1]);
      else if (!insideRoot(outDir, target) || !existsSync(target)) problems.push(file + ": missing reference " + match[1]);
    }
  }

  if (problems.length > 0) {
    throw new Error("Extension build is invalid:\n  " + problems.join("\n  "));
  }

  const load = (file) => import(pathToFileURL(path.join(outDir, file)).href + "?v=" + Date.now());
  const sourceModule = await load("extension/state/source.js");
  const expectedSource = mode === "native" ? "Native" : "Fixture";
  if (sourceModule.STATE_SOURCE !== expectedSource) {
    throw new Error("State source is " + sourceModule.STATE_SOURCE + ", expected " + expectedSource);
  }
  const config = await load("extension/runtime/config.js");
  if (config.NATIVE_HOST_NAME !== NATIVE_HOST_NAME) throw new Error("Native host name is not " + NATIVE_HOST_NAME);

  if (mode === "native") {
    return { outDir, extensionId, files, mode, fixture: null, hostName: config.NATIVE_HOST_NAME, permissions };
  }

  const fixtureModule = await load("extension/state/smoke-state.js");
  const { compilePacScript } = await load("pac/index.js");
  const { validateBrowserRoutingState } = await load("domain/browser-routing/index.js");
  const { PHASE3_PROXY_ENDPOINT } = config;
  const validated = validateBrowserRoutingState(fixtureModule.SMOKE_STATE);
  if (!validated.ok) throw new Error("Fixture state is invalid: " + JSON.stringify(validated.issues.slice(0, 5)));
  if (options.expectFixture && fixtureModule.FIXTURE_NAME !== options.expectFixture) {
    throw new Error("Fixture is " + fixtureModule.FIXTURE_NAME + ", expected " + options.expectFixture);
  }
  const compileOptions = options.expectFixture === SLICE8_FAILCLOSED_FIXTURE_NAME
    ? { failClosedBlocking: true }
    : { proxyHost: PHASE3_PROXY_ENDPOINT.proxyHost, proxyPort: PHASE3_PROXY_ENDPOINT.proxyPort };
  const compiled = compilePacScript(fixtureModule.SMOKE_STATE, compileOptions);
  if (!compiled.ok) throw new Error("Fixture does not compile: " + compiled.error.code);

  return {
    outDir,
    extensionId,
    files,
    mode,
    permissions,
    fixture: fixtureModule.FIXTURE_NAME,
    revision: compiled.metadata.revision,
    ruleCount: compiled.metadata.ruleCount,
    enabledRuleCount: compiled.metadata.enabledRuleCount,
    pacBytes: compiled.metadata.byteLength,
    proxyRoute: compiled.metadata.proxyRoute
  };
}

function parseArgs(argv) {
  const options = {};
  for (const arg of argv) {
    const match = /^--(mode|fixture|out)=(.+)$/.exec(arg);
    if (!match) throw new Error("Unknown argument " + arg);
    if (match[1] === "out") options.outDir = path.resolve(match[2]);
    else options[match[1]] = match[2];
  }
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildExtension(parseArgs(process.argv.slice(2))).then((report) => {
    console.log("Built " + report.outDir);
    console.log("  extension ID: " + report.extensionId);
    console.log("  files:        " + report.files.length);
    console.log("  state source: " + (report.mode === "native" ? "Native (" + report.hostName + ")" : "Fixture"));
    console.log("  permissions:  " + report.permissions.join(", "));
    if (report.mode === "fixture") {
      console.log("  fixture:      " + report.fixture + ", revision " + report.revision +
        ", " + report.enabledRuleCount + " enabled of " + report.ruleCount + " rules");
      console.log("  PAC:          " + report.pacBytes + " bytes, VPN route " + report.proxyRoute);
    }
    console.log("BUILD OK");
  }, (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
