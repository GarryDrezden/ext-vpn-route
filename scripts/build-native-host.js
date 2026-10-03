// Portable publish of the production native host + protocol smoke test.
//
//   dist/native-host/SelectiveVpnRouter.NativeHost.exe   (self-contained, single file, win-x64)
//
// Does not touch the registry: registration is scripts/native-host/register.ps1.
//
// Usage: node scripts/build-native-host.js [--skip-publish] [--tests]
//   --skip-publish  only validate and smoke-test an existing dist/native-host
//   --tests         additionally run the xUnit suite against the published binary

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createNativeStateProvider } from "../src/extension/state/native-state-provider.js";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const HOST_OUT = path.join(ROOT, "dist", "native-host");
export const HOST_EXE_NAME = "SelectiveVpnRouter.NativeHost.exe";
export const HOST_EXE = path.join(HOST_OUT, HOST_EXE_NAME);
export const ALLOWED_ORIGIN = "chrome-extension://lfaekfalhkgmbfdjjlfcalanhijeaien/";
const PROJECT = path.join(ROOT, "src", "native-host", "SelectiveVpnRouter.NativeHost.csproj");
const TEST_PROJECT = path.join(ROOT, "tests", "native-host", "SelectiveVpnRouter.NativeHost.Tests.csproj");

function publish() {
  rmSync(HOST_OUT, { recursive: true, force: true });
  mkdirSync(HOST_OUT, { recursive: true });
  execFileSync("dotnet", [
    "publish", PROJECT,
    "-c", "Release",
    "-r", "win-x64",
    "--self-contained", "true",
    "-p:PublishSingleFile=true",
    "-p:DebugType=none",
    "-o", HOST_OUT,
    "--nologo"
  ], { stdio: "inherit" });
}

function validateOutput() {
  if (!existsSync(HOST_EXE)) throw new Error("Published host not found: " + HOST_EXE);
  const files = readdirSync(HOST_OUT).sort();
  if (files.length !== 1 || files[0] !== HOST_EXE_NAME) {
    throw new Error("dist/native-host must contain only " + HOST_EXE_NAME + "; found " + files.join(", "));
  }
  return statSync(HOST_EXE).size;
}

function frame(message) {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

function parseFrames(buffer) {
  const messages = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (buffer.length - offset < 4) throw new Error("stdout ends with a partial header");
    const length = buffer.readUInt32LE(offset);
    offset += 4;
    if (buffer.length - offset < length) throw new Error("stdout ends with a partial payload");
    messages.push(JSON.parse(buffer.subarray(offset, offset + length).toString("utf8")));
    offset += length;
  }
  return messages;
}

/** Runs the host the way Chromium does on Windows: origin + --parent-window, framed stdin. */
export function runHost(messages, args = [ALLOWED_ORIGIN, "--parent-window=0"], exe = HOST_EXE) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => { child.kill(); reject(new Error("host did not exit in time")); }, 20000);
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      try {
        resolve({ code, responses: parseFrames(Buffer.concat(stdout)), stderr: Buffer.concat(stderr).toString("utf8") });
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(Buffer.concat(messages.map(frame)));
  });
}

/** chrome.runtime stand-in that starts a new host process per message, like sendNativeMessage. */
function processRuntime(exe) {
  const runtime = {
    lastError: undefined,
    sendNativeMessage(hostName, message, callback) {
      runHost([message], [ALLOWED_ORIGIN, "--parent-window=0"], exe).then(
        (result) => {
          if (result.responses.length === 0) {
            runtime.lastError = { message: "Native host has exited." };
            try { callback(undefined); } finally { runtime.lastError = undefined; }
          } else {
            callback(result.responses[0]);
          }
        },
        (error) => {
          runtime.lastError = { message: "Error when communicating with the native messaging host. " + error.message };
          try { callback(undefined); } finally { runtime.lastError = undefined; }
        });
    }
  };
  return runtime;
}

function check(condition, message) {
  if (!condition) throw new Error("SMOKE FAIL: " + message);
  console.log("  PASS " + message);
}

export async function smoke(exe = HOST_EXE) {
  const ping = { protocolVersion: 1, requestId: "smoke-ping", command: "ping" };
  const getState = { protocolVersion: 1, requestId: "smoke-state", command: "getState" };

  const ok = await runHost([ping, getState, { protocolVersion: 1, requestId: "smoke-x", command: "exec" }], undefined, exe);
  check(ok.code === 0, "clean EOF exit code 0");
  check(ok.responses.length === 3, "three framed responses, stdout contains frames only");
  check(ok.responses[0].ok === true && ok.responses[0].result.command === "pong" &&
    ok.responses[0].result.host === "SelectiveVpnRouter.NativeHost" && ok.responses[0].result.protocolVersion === 1,
  "ping -> pong (host " + ok.responses[0].result.host + " " + ok.responses[0].result.hostVersion + ")");
  check(ok.responses[0].requestId === "smoke-ping", "requestId preserved");
  check(ok.responses[1].ok === false && ok.responses[1].error.code === "service_unavailable",
    "getState -> service_unavailable (no Service connector in Phase 4)");
  check(ok.responses[2].error.code === "unknown_command", "arbitrary command -> unknown_command");
  check(ok.stderr.includes("[native-host]"), "diagnostics go to stderr");

  const wrong = await runHost([ping], ["chrome-extension://onodojebmdbcndjelgfhoiffeojngmbd/"], exe);
  check(wrong.code === 4 && wrong.responses.length === 1 && wrong.responses[0].error.code === "forbidden_origin",
    "spike extension origin -> forbidden_origin, exit 4");
  const missing = await runHost([ping], [], exe);
  check(missing.code === 4, "missing origin -> exit 4");

  const provider = createNativeStateProvider({ runtime: processRuntime(exe), hostName: "com.vpnroute.browser" });
  const fetched = await provider.getState();
  check(fetched.ok === false && fetched.error.code === "host_error" && fetched.error.hostErrorCode === "service_unavailable" &&
    fetched.transport === "AVAILABLE" && fetched.service === "UNAVAILABLE",
  "extension NativeStateProvider over the real host: transport AVAILABLE, Service UNAVAILABLE");
}

function runTests() {
  execFileSync("dotnet", ["test", TEST_PROJECT, "-c", "Release", "--nologo"], {
    stdio: "inherit",
    env: { ...process.env, NATIVE_HOST_EXE: HOST_EXE }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = new Set(process.argv.slice(2));
  for (const arg of args) {
    if (arg !== "--skip-publish" && arg !== "--tests") throw new Error("Unknown argument " + arg);
  }
  (async () => {
    if (process.platform !== "win32") throw new Error("The native host is published for win-x64 only.");
    if (!args.has("--skip-publish")) publish();
    const size = validateOutput();
    console.log("Published " + HOST_EXE);
    console.log("  size: " + size + " bytes (" + (size / 1024 / 1024).toFixed(1) + " MiB), self-contained single file, win-x64");
    console.log("Protocol smoke test:");
    await smoke();
    if (args.has("--tests")) runTests();
    console.log("NATIVE HOST BUILD OK (registry not modified)");
  })().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
