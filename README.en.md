[Русский](README.md) · [English](README.en.md)

# ext-vpn-route

**VPN Route extension for routing sites by domain through the local VPN Route application.**

The extension receives browser routing rules from VPN Route and applies them in the browser. It does not create a VPN connection on its own — VPN and the local SOCKS proxy are provided by the main VPN Route application.

Browser component of [VPN Route](https://github.com/GarryDrezden/Vpn-gateway): selective site routing by domain in Chromium.

The whole browser is not sent through VPN. The user sets a route per site: default, through VPN, or direct.

Example: Telegram and Cursor go through VPN, Yandex Browser stays direct, while inside the browser YouTube and ChatGPT go through VPN and Ozon and Gosuslugi stay direct.

## What the extension does

- detects the current domain;
- lets you choose a route in a couple of actions;
- applies proxy policy via `chrome.proxy` and PAC;
- shows which route is active;
- receives rules from the VPN Route desktop app over Native Messaging. On failure it keeps the last applied PAC and does not fall back to DIRECT.

The extension does not bring up VPN, change system routing, or store rules as the source of truth.

## What is not in this repo

This repository does not contain the Windows app, service, driver, OpenVPN, or local proxy.

Those live in [Vpn-gateway](https://github.com/GarryDrezden/Vpn-gateway):

- explicit SOCKS5 on loopback;
- DNS for addresses that go through VPN;
- rule storage (VPN Route Service is the single source of truth);
- portable delivery.

This repo contains the Native Messaging Host `com.vpnroute.browser` (`src/native-host/`) — a bridge between the extension and Service without its own business logic. It does not store or cache rules, and does not touch files, registry, network, or processes. It reads state from Service over the browser-routing pipe (manifest + pages, rule writes when `browserRoutingWrite` is present); **1.0.0** adds push sync via `watchEvents` / `connectNative`, with periodic `chrome.alarms` as fallback polling.

**1.0.0 (desktop is the primary editor):** Browser Routing rules are edited primarily in the VPN Route desktop app (tab «Браузер»); the extension popup is a companion and quick control surface. Changes from Service are usually picked up immediately via push (Native Host → `connectNative`); the one-minute alarm remains fallback polling.

## V1 behavior

Routing is per domain, not per tab. Two tabs on the same site share one rule.

Extension format: Manifest V3.

Modes:

- **Default** — remove a broader rule and restore the browser’s normal path. In V1 this is direct.
- **Through VPN** — local SOCKS5 only. If VPN is unavailable, the request fails and does not bypass.
- **Direct** — always bypass VPN.

Rule scope:

- this host only;
- host and its subdomains.

More specific rules win. `video.google.com` can go through VPN while `google.com` stays direct.

Local addresses (`localhost`, `127.0.0.0/8`, `::1`, and private IP literals) are not sent to the VPN proxy. The exact list is in `docs/pac-compiler-v1.md`.

## Verified browsers

The primary browser for current production acceptance is **Yandex Browser**.

- **Yandex Browser** — used for production extension acceptance (Phase 3) and VPN Route Service integration (Phase 5).
- **Google Chrome** — the early manual Phase 0A PAC/SOCKS5 spike **PASSED**, but the current **1.0.0 RC19** production chain was not separately accepted in Chrome.
- **Microsoft Edge** — not manually tested and not part of the current acceptance matrix.

The extension uses **Manifest V3** and Chromium APIs, so it is architecturally aimed at Chromium browsers; that is **not** a claim of verified manual compatibility with Chrome or Edge in RC19.

## How traffic flows

```text
Chromium
  PAC
    ├─ domain via VPN → SOCKS5 127.0.0.1:<port>
    └─ everything else  → direct
         │
         ▼
Native Messaging Host
         │
         ▼
VPN Route Service
  loopback SOCKS5
  DNS on VPN side
  connection via OpenVPN
```

For a “through VPN” domain, PAC does not substitute a fallback direct path.

## Product version

**VPN Route 1.0.0** (extension production ID `lfaekfalhkgmbfdjjlfcalanhijeaien`, Native Host `com.vpnroute.browser`, protocol **v1**). Version policy: [docs/product-version.md](docs/product-version.md).

## Current test baseline

On current `main` locally (no live/E2E mutations):

- `npm test` — **611** Node tests
- `npm run test:native-host` — **225** Native Host xUnit tests

## Status

- Phase 0A, browser → PAC → SOCKS5: **PASS** in Yandex Browser and Chrome *(historical manual Phase 0A spike)*. `docs/phase0-acceptance.md`.
- Phase 0B, Native Messaging ping/pong: **PASS in Yandex Browser**, Chrome intentionally not tested. `docs/phase0b-acceptance.md`.
- Phase 1, domain model and matcher: **PASS, automated tests**. `src/domain/browser-routing/`, contract `docs/browser-routing-contract-v1.md`.
- Phase 2, PAC compiler: **PASS, automated tests**. `src/pac/`, spec `docs/pac-compiler-v1.md`.
- Phase 3, production MV3 extension from fixed state: **FULL PASS in Yandex Browser**, including ~382 KB PAC and read-back `data_match`. `src/extension/`, `docs/phase3-extension-runtime.md`, results `docs/phase3-acceptance.md`.
- Phase 4, native state transport (extension → `com.vpnroute.browser` → Service client interface): **PASS, automated tests**. `docs/phase4-native-state-transport.md`.
- Phase 5, VPN Route Service integration (host → `\\.\pipe\SelectiveVpnRouter.BrowserRouting` → authoritative state, paged, generation + revision): **FULL PASS** — automated tests, E2E 10k rules, Yandex Browser with production Native Host and real service. `docs/phase5-service-integration.md`, `docs/phase5-acceptance.md`, protocols `docs/native-messaging-protocol-v1.md` and `docs/service-ipc-browser-routing-v1.md`.
- **Slice 8 (Browser Integration Port v1) — ACCEPTED:** Integration API v1, explicit loopback SOCKS5 browser proxy, VPN-bound session DNS (OpenVPN PUSH), fail-closed PAC (`SOCKS5 127.0.0.1:0` with no implicit DIRECT), heartbeat/stale observability, endpoint recovery via MV3 `chrome.alarms` (1 min), acceptance in real Yandex Browser. *At Slice 8 acceptance:* **497** Node tests, **210** Native Host tests. Dev-only fail-closed fixture: `npm run build:slice8-failclosed-fixture` → `artifacts/slice8-failclosed-fixture`.
- **Slice 9 (Browser Routing writes + Rules UI) — ACCEPTED / COMPLETE**
  - **9A — DONE** (vpn-gateway `42246df`, deployed): Service write API: `upsertRule` / `deleteRule` / `resetRules`, capability `browserRoutingWrite`.
  - **9B — DONE** (`220d5a6`, deployed): Native Host write bridge + extension writer (`browser-routing-writer.js`, `browser-routing-write-contract.js`).
  - **9C — DONE** (this repo, extension reloaded): popup Rules UI (list ↔ editor, diagnostics secondary), draft in `chrome.storage.session` for incomplete forms. No new Service/Native Host methods.
  - **Manual live acceptance:** create, edit, on/off toggle, delete with confirmation, authoritative sync and PAC after write (fail-closed when VPN off), session draft survives popup close/reopen.
  - **Automated tests only (live not required):** `resetRules`, `revision_conflict`, ambiguous transport failure, `validation_failed`, capability read-only/absent, unavailable snapshot, mutation serialization, `expectedRevision` propagation.
  - *Historical baseline at Slice 9 acceptance:* **552** Node tests, **219** Native Host tests.
- **Slice 10A — developer install/update orchestrator — ACCEPTED / COMPLETE** (vpn-gateway): `scripts\install-vpn-route.ps1` builds/tests the extension stack, runs `update-desktop.ps1`, registers `com.vpnroute.browser`, read-only integration check (`scripts/verify-browser-integration-readonly.js`). Live acceptance: `-CheckOnly`, fail-safe before mutations, full install with elevation, manual extension reload. Windows PowerShell 5.1 parser check: `vpn-gateway\scripts\validate-install-vpn-route-parse.ps1`. External OpenVPN is never touched. *At Slice 10A acceptance:* **823** vpn-gateway tests via `update-desktop.ps1`.

Research-phase temporary code lives in `spike/` and is not promoted to product.

**Canonical developer install/update** (elevated PowerShell from the vpn-gateway repo):

```powershell
cd ..\vpn-gateway
powershell -ExecutionPolicy Bypass -File scripts\install-vpn-route.ps1
```

Read-only audit (no builds, no registry/Service changes, no BrowserRouting writes): `-CheckOnly`. Close the VPN Route GUI before a full update. Override extension repo path: `-ExtensionRepoPath` or `EXT_VPN_ROUTE_ROOT`.

After a successful run, reload the extension at `browser://extensions` or **Load unpacked** from `dist\extension` (production ID `lfaekfalhkgmbfdjjlfcalanhijeaien`).

```text
npm test                          # Node: domain, PAC, extension, integration
npm run test:native-host          # xUnit: production native host
npm run test:e2e                  # Service test host → pipe → host exe → extension, 10000 rules
node scripts/check-live-service.js  # read-only: host exe → installed service
npm run build:extension           # dist/extension, Fixture mode (default)
npm run build:extension:native    # dist/extension, Native: state from native host
npm run build:extension:large     # dev only: ~10000 rules
npm run build:native-host         # dist/native-host/SelectiveVpnRouter.NativeHost.exe + smoke
npm run measure:pac
```

The Vpn-gateway repo is resolved next door at `..\vpn-gateway`, or via `VPN_GATEWAY_ROOT`:

- `test:e2e` fails without it: it builds the Service test host from there;
- cross-repo checks in `npm test` are skipped without it.

Host registration is HKCU only, no UAC: `scripts\native-host\register.ps1`, `status.ps1`, `unregister.ps1`.

JS tests use built-in `node --test`, no dependencies. Generated PAC runs in isolated `node:vm` and is checked against the Phase 1 matcher.
