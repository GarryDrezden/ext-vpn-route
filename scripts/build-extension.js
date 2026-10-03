// Dependency-free build of the unpacked MV3 extension.
//
// dist/extension/ mirrors src/ so relative ES module imports work unchanged:
//   manifest.json              <- src/extension/manifest.json
//   extension/**               <- src/extension/** (without manifest.json)
//   pac/*.js                   <- src/pac/*.js
//   domain/browser-routing/*.js <- src/domain/browser-routing/*.js
//
// Usage: node scripts/build-extension.js [--fixture=normal|large] [--out=<dir inside dist/>]

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { extensionIdFromKey } from "./extension-id.js";
import { createLargeFixtureState, renderFixtureModule } from "./large-fixture.js";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DIST_ROOT = path.join(ROOT, "dist");
export const DEFAULT_OUT = path.join(DIST_ROOT, "extension");
export const PRODUCTION_EXTENSION_ID = "lfaekfalhkgmbfdjjlfcalanhijeaien";
export const SPIKE_EXTENSION_ID = "onodojebmdbcndjelgfhoiffeojngmbd";
export const FIXTURES = Object.freeze(["normal", "large"]);

const SOURCES = Object.freeze([
  { from: "src/extension", to: "extension", skip: ["manifest.json"] },
  { from: "src/pac", to: "pac" },
  { from: "src/domain/browser-routing", to: "domain/browser-routing" }
]);
const ALLOWED_EXTENSIONS = Object.freeze([".js", ".json", ".html", ".css"]);
const ALLOWED_PERMISSIONS = Object.freeze(["proxy", "storage"]);
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
  [/\bsendNativeMessage\b|\bconnectNative\b/, "native messaging"],
  [/https?:\/\/[a-z0-9]/i, "remote URL"]
]);

function assertSafeOut(outDir) {
  const resolved = path.resolve(outDir);
  const relative = path.relative(DIST_ROOT, resolved);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Refusing to build outside " + DIST_ROOT + ": " + resolved);
  }
  return resolved;
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

/**
 * @param {{ fixture?: "normal" | "large", outDir?: string, quiet?: boolean }} [options]
 */
export async function buildExtension(options = {}) {
  const fixture = options.fixture || "normal";
  if (!FIXTURES.includes(fixture)) throw new Error("Unknown fixture " + fixture);
  const outDir = assertSafeOut(options.outDir || DEFAULT_OUT);

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  cpSync(path.join(ROOT, "src/extension/manifest.json"), path.join(outDir, "manifest.json"));
  for (const source of SOURCES) {
    const fromDir = path.join(ROOT, source.from);
    for (const file of walk(fromDir)) {
      if (source.skip && source.skip.includes(file)) continue;
      const target = path.join(outDir, source.to, file);
      mkdirSync(path.dirname(target), { recursive: true });
      cpSync(path.join(fromDir, file), target);
    }
  }
  if (fixture === "large") {
    writeFileSync(path.join(outDir, "extension/state/smoke-state.js"),
      renderFixtureModule("large", createLargeFixtureState()), "utf8");
  }

  return validateExtension(outDir, { expectFixture: fixture });
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
 * @param {{ expectFixture?: string }} [options]
 */
export async function validateExtension(outDir, options = {}) {
  const problems = [];
  const files = walk(outDir);

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
  const permissions = Array.isArray(manifest.permissions) ? [...manifest.permissions].sort() : [];
  if (JSON.stringify(permissions) !== JSON.stringify(ALLOWED_PERMISSIONS)) {
    problems.push("permissions must be exactly " + ALLOWED_PERMISSIONS.join(", ") + "; got " + permissions.join(", "));
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
  if (extensionId !== PRODUCTION_EXTENSION_ID) problems.push("extension ID " + extensionId + " is not " + PRODUCTION_EXTENSION_ID);

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
      if (pattern.test(source)) problems.push(file + ": forbidden " + label);
    }
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

  const fixtureModule = await import(pathToFileURL(path.join(outDir, "extension/state/smoke-state.js")).href + "?v=" + Date.now());
  const { compilePacScript } = await import(pathToFileURL(path.join(outDir, "pac/index.js")).href);
  const { validateBrowserRoutingState } = await import(pathToFileURL(path.join(outDir, "domain/browser-routing/index.js")).href);
  const { PHASE3_PROXY_ENDPOINT } = await import(pathToFileURL(path.join(outDir, "extension/runtime/config.js")).href);
  const validated = validateBrowserRoutingState(fixtureModule.SMOKE_STATE);
  if (!validated.ok) throw new Error("Fixture state is invalid: " + JSON.stringify(validated.issues.slice(0, 5)));
  if (options.expectFixture && fixtureModule.FIXTURE_NAME !== options.expectFixture) {
    throw new Error("Fixture is " + fixtureModule.FIXTURE_NAME + ", expected " + options.expectFixture);
  }
  const compiled = compilePacScript(fixtureModule.SMOKE_STATE, PHASE3_PROXY_ENDPOINT);
  if (!compiled.ok) throw new Error("Fixture does not compile: " + compiled.error.code);

  return {
    outDir,
    extensionId,
    files,
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
    const match = /^--(fixture|out)=(.+)$/.exec(arg);
    if (!match) throw new Error("Unknown argument " + arg);
    options[match[1] === "out" ? "outDir" : "fixture"] = match[1] === "out" ? path.resolve(match[2]) : match[2];
  }
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildExtension(parseArgs(process.argv.slice(2))).then((report) => {
    console.log("Built " + report.outDir);
    console.log("  extension ID: " + report.extensionId);
    console.log("  files:        " + report.files.length);
    console.log("  fixture:      " + report.fixture + ", revision " + report.revision +
      ", " + report.enabledRuleCount + " enabled of " + report.ruleCount + " rules");
    console.log("  PAC:          " + report.pacBytes + " bytes, VPN route " + report.proxyRoute);
    console.log("BUILD OK");
  }, (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
