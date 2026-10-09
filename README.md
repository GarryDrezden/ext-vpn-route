# ext-vpn-route

Браузерная часть [VPN Route](https://github.com/GarryDrezden/Vpn-gateway): выборочная маршрутизация сайтов по доменам в Chromium.

Браузер целиком через VPN не отправляется. Пользователь задаёт маршрут сайта: по умолчанию, через VPN или напрямую.

Пример: Telegram и Cursor идут через VPN, Yandex Browser — напрямую, а внутри браузера YouTube и ChatGPT идут через VPN, Ozon и Госуслуги — напрямую.

## Что делает расширение

- определяет текущий домен;
- даёт выбрать маршрут за пару действий;
- применяет политику прокси через `chrome.proxy` и PAC;
- показывает, какой маршрут сейчас действует;
- получает правила от desktop VPN Route по Native Messaging. При сбое оставляет последний применённый PAC и не переходит на DIRECT.

Расширение не поднимает VPN, не меняет системную маршрутизацию и не хранит правила как источник истины.

## Чего здесь нет

Этот репозиторий не содержит Windows-приложение, службу, драйвер, OpenVPN и локальный прокси.

Их репозиторий — [Vpn-gateway](https://github.com/GarryDrezden/Vpn-gateway). Там же живут:

- явный SOCKS5 на loopback;
- DNS для адресов, которые идут через VPN;
- хранение правил (VPN Route Service — единственный источник истины);
- portable-поставка.

Здесь лежит Native Messaging Host `com.vpnroute.browser` (`src/native-host/`) — мост между расширением и Service без собственной бизнес-логики. Он правил не хранит и не кэширует, файлы, реестр, сеть и процессы не трогает. Состояние он читает у Service по read-only named pipe: два метода, постранично.

## Поведение V1

Маршрут задаётся домену, не вкладке. Две вкладки одного сайта используют одно правило.

Браузеры, в порядке приоритета:

1. Yandex Browser
2. Google Chrome
3. Microsoft Edge

Формат расширения — Manifest V3.

Режимы:

- **По умолчанию** — снять более общее правило и вернуть обычный путь браузера. В V1 это напрямую.
- **Через VPN** — только локальный SOCKS5. Если VPN недоступен, запрос обрывается и не уходит в обход.
- **Напрямую** — всегда мимо VPN.

Область правила:

- только этот хост;
- хост и его поддомены.

Более конкретное правило побеждает. `video.google.com` может идти через VPN, пока `google.com` идёт напрямую.

Локальные адреса (`localhost`, `127.0.0.0/8`, `::1` и частные IP-литералы) в VPN-прокси не отправляются. Точный список — в `docs/pac-compiler-v1.md`.

## Как проходит трафик

```text
Chromium
  PAC
    ├─ домен через VPN → SOCKS5 127.0.0.1:<port>
    └─ остальное        → напрямую
         │
         ▼
Native Messaging Host
         │
         ▼
VPN Route Service
  loopback SOCKS5
  DNS на стороне VPN
  соединение через OpenVPN
```

Для домена «через VPN» PAC не подставляет запасной прямой путь.

## Статус

- Phase 0A, browser → PAC → SOCKS5: **PASS** в Yandex Browser и Chrome. `docs/phase0-acceptance.md`.
- Phase 0B, Native Messaging ping/pong: **PASS в Yandex Browser**, Chrome намеренно не тестировался. `docs/phase0b-acceptance.md`.
- Phase 1, доменная модель и matcher: **PASS, автоматические тесты**. `src/domain/browser-routing/`, контракт `docs/browser-routing-contract-v1.md`.
- Phase 2, PAC compiler: **PASS, автоматические тесты**. `src/pac/`, описание `docs/pac-compiler-v1.md`.
- Phase 3, production MV3 extension из фиксированного состояния: **FULL PASS в Yandex Browser**, включая PAC 382 KB и read-back `data_match`. `src/extension/`, `docs/phase3-extension-runtime.md`, результаты `docs/phase3-acceptance.md`.
- Phase 4, production native state transport (extension → `com.vpnroute.browser` → интерфейс клиента Service): **PASS, автоматические тесты**. `docs/phase4-native-state-transport.md`.
- Phase 5, интеграция с VPN Route Service (host → `\\.\pipe\SelectiveVpnRouter.BrowserRouting` → authoritative state, постранично, generation + revision): **FULL PASS** — автоматические тесты, E2E 10k rules, Yandex Browser с production host и реальной службой. `docs/phase5-service-integration.md`, `docs/phase5-acceptance.md`, протоколы `docs/native-messaging-protocol-v1.md` и `docs/service-ipc-browser-routing-v1.md`.
- **Slice 8 (Browser Integration Port v1) — ACCEPTED:** Integration API v1, explicit loopback SOCKS5 browser proxy, VPN-bound session DNS (OpenVPN PUSH), fail-closed PAC (`SOCKS5 127.0.0.1:0` без implicit DIRECT), heartbeat/stale observability, dynamic endpoint recovery через MV3 `chrome.alarms` (1 min), real Yandex acceptance. Baseline: **497** Node tests, **210** Native Host tests. Dev-only fail-closed browser fixture: `npm run build:slice8-failclosed-fixture` → `artifacts/slice8-failclosed-fixture`.
- **Slice 9A — DONE** (vpn-gateway `42246df`): Service write API `upsertRule` / `deleteRule` / `resetRules`, capability `browserRoutingWrite` (not deployed).
- **Slice 9B — DONE:** Native Host write bridge + extension `browser-routing-writer.js` (no rule UI).
- **Slice 9C — NEXT / local:** Browser Routing rules UI in popup (writer only; no new Service methods).

Временный код feasibility-фазы лежит в `spike/` и в продукт не переносится.

```text
npm test                          # Node: domain, PAC, extension, integration
npm run test:native-host          # xUnit: production native host
npm run test:e2e                  # Service test host → pipe → host exe → extension, 10000 правил
node scripts/check-live-service.js  # read-only: host exe → установленная служба
npm run build:extension           # dist/extension, Fixture (по умолчанию)
npm run build:extension:native    # dist/extension, Native: состояние от native host
npm run build:extension:large     # dev-only: ~10000 правил
npm run build:native-host         # dist/native-host/SelectiveVpnRouter.NativeHost.exe + smoke
npm run measure:pac
```

Checkout Vpn-gateway ищется рядом, в `..\vpn-gateway`, или по `VPN_GATEWAY_ROOT`:

- `test:e2e` без него падает: он собирает оттуда Service test host;
- межрепозиторные проверки в `npm test` без него пропускаются.

Регистрация host — только HKCU, без UAC: `scripts\native-host\register.ps1`, `status.ps1`, `unregister.ps1`.

JS-тесты идут на встроенном `node --test`, без зависимостей. Сгенерированный PAC исполняется в изолированном `node:vm` и сверяется с matcher Phase 1.
