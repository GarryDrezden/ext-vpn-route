import path from "node:path";
import { fileURLToPath } from "node:url";
import { ARTIFACTS_ROOT, ROOT, SPIKE_EXTENSION_ID, buildExtension } from "./build-extension.js";
import { compilePacScript } from "../src/pac/index.js";
import { createSlice8FailClosedState, SLICE8_FAILCLOSED_FIXTURE_NAME } from "./slice8-failclosed-fixture.js";
import { loadPac, DIRECT } from "../tests/pac/helpers.js";
import { FAIL_CLOSED_BLOCKING_VR_VPN } from "../src/pac/blocking.js";

const OUT_DIR = path.join(ARTIFACTS_ROOT, "slice8-failclosed-fixture");

const assert = {
  equal(actual, expected) {
    if (actual !== expected) throw new Error("Expected " + expected + ", got " + actual);
  }
};

export async function buildSlice8FailClosedFixture() {
  const report = await buildExtension({
    mode: "fixture",
    fixture: SLICE8_FAILCLOSED_FIXTURE_NAME,
    outDir: OUT_DIR
  });
  const compiled = compilePacScript(createSlice8FailClosedState(), { failClosedBlocking: true });
  if (!compiled.ok) throw new Error("Slice8 fixture PAC compile failed: " + compiled.error.code);
  const script = compiled.script;
  if (!script.includes('var VR_VPN = "SOCKS5 127.0.0.1:0";')) {
    throw new Error("Slice8 fixture PAC missing blocking VR_VPN directive");
  }
  const runtime = loadPac(script);
  assert.equal(runtime.find("api.ipify.org"), FAIL_CLOSED_BLOCKING_VR_VPN);
  assert.equal(runtime.find("example.com"), DIRECT);
  return { ...report, outDir: OUT_DIR, extensionId: SPIKE_EXTENSION_ID, blockingDirective: FAIL_CLOSED_BLOCKING_VR_VPN };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildSlice8FailClosedFixture().then((report) => {
    console.log("Built " + report.outDir);
    console.log("  extension ID: " + report.extensionId + " (spike key — isolated from production)");
    console.log("  fixture:      " + report.fixture + ", revision " + report.revision);
    console.log("  rules:        " + report.enabledRuleCount + " enabled of " + report.ruleCount);
    console.log("  PAC endpoint: " + report.proxyRoute);
    console.log("  blocking:     " + report.blockingDirective);
    console.log("BUILD OK");
  }, (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
