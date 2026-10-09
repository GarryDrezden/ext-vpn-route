import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ROOT } from "../../scripts/build-extension.js";

const POPUP_HTML = path.join(ROOT, "src/extension/popup/popup.html");
const POPUP_CSS = path.join(ROOT, "src/extension/popup/popup.css");
const RULES_UI = path.join(ROOT, "src/extension/popup/rules-ui.js");

test("rules popup uses list/editor views without rule dialog", () => {
  const html = readFileSync(POPUP_HTML, "utf8");
  assert.match(html, /id="rules-list-view"/);
  assert.match(html, /id="rules-editor-view"/);
  assert.doesNotMatch(html, /id="rule-dialog"/);
  assert.doesNotMatch(html, /<dialog[^>]*id="rule-/);
  assert.match(html, /id="rules-confirm-bar"/);
  assert.doesNotMatch(html, /id="rules-confirm-dialog"/);
});

test("reset rules lives under diagnostics, not beside primary add", () => {
  const html = readFileSync(POPUP_HTML, "utf8");
  const diagnosticsIdx = html.indexOf('id="diagnostics-details"');
  const resetIdx = html.indexOf('id="rules-reset"');
  const sectionHeadIdx = html.indexOf('class="rules-section-head"');
  assert.ok(diagnosticsIdx >= 0 && resetIdx > diagnosticsIdx);
  const headBlock = html.slice(sectionHeadIdx, sectionHeadIdx + 400);
  assert.doesNotMatch(headBlock, /rules-reset/);
});

test("diagnostic action buttons live inside diagnostics details", () => {
  const html = readFileSync(POPUP_HTML, "utf8");
  const start = html.indexOf('id="diagnostics-details"');
  const end = html.indexOf("</details>", start);
  const block = html.slice(start, end);
  assert.match(block, /id="reapply"/);
  assert.match(block, /id="clear"/);
  assert.match(block, /id="refresh"/);
  const after = html.slice(end + "</details>".length);
  assert.doesNotMatch(after, /id="reapply"/);
  assert.doesNotMatch(after, /id="clear"/);
  assert.doesNotMatch(after, /id="refresh"/);
});

test("diagnostics section is collapsed by default", () => {
  const html = readFileSync(POPUP_HTML, "utf8");
  assert.match(html, /<details[^>]*class="diagnostics"/);
  assert.doesNotMatch(html, /<details[^>]*class="diagnostics"[^>]*\sopen/);
});

test("primary diagnostic buttons use Russian labels in HTML", () => {
  const html = readFileSync(POPUP_HTML, "utf8");
  assert.match(html, />Обновить и применить</);
  assert.match(html, />Сбросить proxy расширения</);
  assert.match(html, />Обновить статус</);
  assert.doesNotMatch(html, />Refresh state & apply</);
  assert.doesNotMatch(html, />Clear extension proxy</);
  assert.doesNotMatch(html, />Refresh status</);
});

test("header compact add starts hidden; delete zone wrapped for create mode", () => {
  const html = readFileSync(POPUP_HTML, "utf8");
  assert.match(html, /id="rules-add"[^>]*\bhidden\b/);
  assert.match(html, /id="rule-delete-zone"[^>]*\bhidden\b/);
  assert.doesNotMatch(html, /id="rule-delete-edit"[^>]*\bhidden\b/);
});

test("popup sizing uses document scroll not nested form scroll", () => {
  const css = readFileSync(POPUP_CSS, "utf8");
  assert.match(css, /width:\s*460px/);
  assert.match(css, /max-height:\s*600px/);
  assert.doesNotMatch(css, /dialog\s*\{/);
  assert.doesNotMatch(css, /\.rules-editor-view[\s\S]*overflow-y:\s*auto/);
});

test("rules-ui does not reference showModal for rule editor", () => {
  const js = readFileSync(RULES_UI, "utf8");
  assert.doesNotMatch(js, /rule-dialog/);
  assert.doesNotMatch(js, /showModal/);
  assert.match(js, /rules-editor-view/);
  assert.match(js, /rules-list-view/);
  assert.match(js, /setDeleteZoneVisible/);
  assert.match(js, /syncHeaderAddButton/);
});
