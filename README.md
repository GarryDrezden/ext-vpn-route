[Русский](README.md) · [English](README.en.md)

# ext-vpn-route

**Расширение VPN Route для маршрутизации сайтов по доменам через локальное приложение VPN Route.**

Расширение получает правила браузерной маршрутизации от VPN Route и применяет их в браузере. Оно не создаёт VPN-соединение самостоятельно — VPN и локальный SOCKS-прокси предоставляет основное приложение VPN Route.

Браузерная часть [VPN Route](https://github.com/GarryDrezden/Vpn-gateway): выборочная маршрутизация сайтов по доменам в Chromium.

Браузер целиком через VPN не отправляется. Пользователь задаёт маршрут сайта: по умолчанию, через VPN или напрямую.

Пример: Telegram и Cursor идут через VPN, Yandex Browser — напрямую, а внутри браузера YouTube и ChatGPT идут через VPN, Ozon и Госуслуги — напрямую.

## Что делает расширение

- определяет текущий домен;
- даёт выбрать маршрут за пару действий;
- применяет политику прокси через `chrome.proxy` и PAC;
- показывает, какой маршрут сейчас действует;
- получает правила от настольного приложения VPN Route по Native Messaging. При сбое оставляет последний применённый PAC и не переходит на DIRECT.

Расширение не поднимает VPN, не меняет системную маршрутизацию и не хранит правила как источник истины.

## Чего здесь нет

Этот репозиторий не содержит Windows-приложение, службу, драйвер, OpenVPN и локальный прокси.

Их репозиторий — [Vpn-gateway](https://github.com/GarryDrezden/Vpn-gateway). Там же живут:

- явный SOCKS5 на loopback (127.0.0.1);
- DNS для адресов, которые идут через VPN;
- хранение правил (VPN Route Service — единственный источник истины);
- portable-поставка.

Здесь лежит Native Messaging Host `com.vpnroute.browser` (`src/native-host/`) — мост между расширением и Service без собственной бизнес-логики. Он правил не хранит и не кэширует, файлы, реестр, сеть и процессы не трогает. Состояние он читает у Service по named pipe (манифест + страницы, запись правил при capability `browserRoutingWrite`); в **1.0.0** push-синхронизация через `watchEvents` / `connectNative`, с периодическим `alarm` как запасным опросом.

**1.0.0 (настольное приложение — основной редактор):** правила Browser Routing в первую очередь редактируются в настольном приложении VPN Route (вкладка «Браузер»); всплывающее окно расширения — спутник и быстрый контроль. Изменения из Service обычно подхватываются сразу по push (Native Host → `connectNative`); минутный `alarm` остаётся запасным опросом.

## Поведение V1

Маршрут задаётся домену, не вкладке. Две вкладки одного сайта используют одно правило.

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

## Проверенные браузеры

Основной браузер для текущей продуктовой приёмки — **Yandex Browser**.

- **Yandex Browser** — использовался в продуктовой приёмке расширения (Phase 3) и интеграции с VPN Route (Phase 5).
- **Google Chrome** — ранний ручной spike Phase 0A (PAC/SOCKS5) был **ПРОЙДЕН**, но текущая продуктовая цепочка **1.0.0 RC19** в Chrome отдельно не принималась.
- **Microsoft Edge** — вручную не проверялся и в текущую матрицу приёмки не входит.

Расширение на **Manifest V3** и API Chromium, поэтому архитектурно рассчитано на Chromium-браузеры; это **не** означает подтверждённую ручную совместимость с Chrome или Edge в RC19.

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
  SOCKS5 на loopback
  DNS на стороне VPN
  соединение через OpenVPN
```

Для домена «через VPN» PAC не подставляет запасной прямой путь.

## Версия продукта

**VPN Route 1.0.0** (штатный ID расширения `lfaekfalhkgmbfdjjlfcalanhijeaien`, Native Host `com.vpnroute.browser`, протокол **v1**). Политика версий: [docs/product-version.md](docs/product-version.md).

## Актуальная базовая линия тестов

Локально на текущей `main` (без живых/E2E-мутаций):

- `npm test` — **611** тестов Node
- `npm run test:native-host` — **225** тестов xUnit (Native Host)

## Статус

- Фаза 0A, браузер → PAC → SOCKS5: **ПРОЙДЕНО** в Yandex Browser и Chrome *(исторический ручной spike Phase 0A)*. `docs/phase0-acceptance.md`.
- Фаза 0B, Native Messaging ping/pong: **ПРОЙДЕНО в Yandex Browser**, Chrome намеренно не тестировался. `docs/phase0b-acceptance.md`.
- Фаза 1, доменная модель и сопоставитель: **ПРОЙДЕНО, автоматические тесты**. `src/domain/browser-routing/`, контракт `docs/browser-routing-contract-v1.md`.
- Фаза 2, компилятор PAC: **ПРОЙДЕНО, автоматические тесты**. `src/pac/`, описание `docs/pac-compiler-v1.md`.
- Фаза 3, штатное расширение MV3 из фиксированного состояния: **ПОЛНОСТЬЮ ПРОЙДЕНО в Yandex Browser**, включая PAC ~382 KB и обратное чтение `data_match`. `src/extension/`, `docs/phase3-extension-runtime.md`, результаты `docs/phase3-acceptance.md`.
- Фаза 4, транспорт состояния через Native Host (расширение → `com.vpnroute.browser` → интерфейс клиента Service): **ПРОЙДЕНО, автоматические тесты**. `docs/phase4-native-state-transport.md`.
- Фаза 5, интеграция с VPN Route Service (host → `\\.\pipe\SelectiveVpnRouter.BrowserRouting` → авторитетное состояние, постранично, generation + revision): **ПОЛНОСТЬЮ ПРОЙДЕНО** — автоматические тесты, E2E на 10 000 правил, Yandex Browser с штатным Native Host и реальной службой. `docs/phase5-service-integration.md`, `docs/phase5-acceptance.md`, протоколы `docs/native-messaging-protocol-v1.md` и `docs/service-ipc-browser-routing-v1.md`.
- **Slice 8 (Browser Integration Port v1) — ПРИНЯТО:** Integration API v1, явный SOCKS5 на loopback для браузера, DNS сессии VPN (OpenVPN PUSH), fail-closed PAC (`SOCKS5 127.0.0.1:0` без неявного DIRECT), наблюдаемость heartbeat/устаревания, восстановление конечной точки через MV3 `chrome.alarms` (1 мин), приёмка в реальном Yandex Browser. *На момент приёмки Slice 8:* **497** тестов Node, **210** тестов Native Host. Сборка fixture fail-closed только для разработки: `npm run build:slice8-failclosed-fixture` → `artifacts/slice8-failclosed-fixture`.
- **Slice 9 (запись Browser Routing + UI правил) — ПРИНЯТО / ЗАВЕРШЕНО**
  - **9A — ГОТОВО** (vpn-gateway `42246df`, развёрнуто): API записи Service: `upsertRule` / `deleteRule` / `resetRules`, возможность `browserRoutingWrite`.
  - **9B — ГОТОВО** (`220d5a6`, развёрнуто): мост записи Native Host + модуль записи расширения (`browser-routing-writer.js`, `browser-routing-write-contract.js`).
  - **9C — ГОТОВО** (этот репозиторий, расширение перезагружено): UI правил во всплывающем окне (список ↔ редактор, диагностика вторична), черновик `chrome.storage.session` для незавершённых форм. Новых методов Service/Native Host нет.
  - **Ручная живая приёмка:** создание, редактирование, переключатель вкл/выкл, удаление с подтверждением, авторитетная синхронизация и PAC после записи (fail-closed при отключённом VPN), черновик сессии переживает закрытие/открытие всплывающего окна.
  - **Только автоматические тесты (живая приёмка не обязательна):** `resetRules`, `revision_conflict`, неоднозначный сбой транспорта, `validation_failed`, возможность `read-only`/`absent`, недоступный снимок состояния, сериализация мутаций, распространение `expectedRevision`.
  - *Историческая базовая линия на момент приёмки Slice 9:* **552** теста Node, **219** тестов Native Host.
- **Slice 10A — оркестратор установки/обновления для разработчика — ПРИНЯТО / ЗАВЕРШЕНО** (vpn-gateway): `scripts\install-vpn-route.ps1` собирает и тестирует стек расширения, запускает `update-desktop.ps1`, регистрирует `com.vpnroute.browser`, проверка интеграции только чтения (`scripts/verify-browser-integration-readonly.js`). Ручная приёмка: `-CheckOnly`, безопасность сбоя до мутаций, полная установка с повышением прав, ручная перезагрузка расширения. Проверка парсера Windows PowerShell 5.1: `vpn-gateway\scripts\validate-install-vpn-route-parse.ps1`. Внешний OpenVPN не затрагивается. *На момент приёмки Slice 10A:* **823** теста vpn-gateway через `update-desktop.ps1`.

Временный код исследовательской фазы лежит в `spike/` и в продукт не переносится.

**Каноническая установка/обновление для разработчика** (повышенный PowerShell из репозитория vpn-gateway):

```powershell
cd ..\vpn-gateway
powershell -ExecutionPolicy Bypass -File scripts\install-vpn-route.ps1
```

Аудит только чтения (без сборок, без изменений реестра/Service, без записей BrowserRouting): `-CheckOnly`. Закройте GUI VPN Route перед полным обновлением. Переопределение репозитория расширения: `-ExtensionRepoPath` или `EXT_VPN_ROUTE_ROOT`.

После успешного запуска перезагрузите расширение на `browser://extensions` или **Загрузить распакованное** из `dist\extension` (штатный ID `lfaekfalhkgmbfdjjlfcalanhijeaien`).

```text
npm test                          # Node: доменная модель, PAC, расширение, интеграция
npm run test:native-host          # xUnit: штатный Native Host
npm run test:e2e                  # тестовый хост Service → канал → Native Host → расширение, 10000 правил
node scripts/check-live-service.js  # только чтение: Native Host → установленная служба
npm run build:extension           # dist/extension, режим Fixture (по умолчанию)
npm run build:extension:native    # dist/extension, Native: состояние от Native Host
npm run build:extension:large     # только для разработки: ~10000 правил
npm run build:native-host         # dist/native-host/SelectiveVpnRouter.NativeHost.exe + дымовой прогон
npm run measure:pac
```

Репозиторий Vpn-gateway ищется рядом, в `..\vpn-gateway`, или по `VPN_GATEWAY_ROOT`:

- `test:e2e` без него падает: оттуда собирается тестовый хост Service;
- межрепозиторные проверки в `npm test` без него пропускаются.

Регистрация Native Host — только HKCU, без UAC: `scripts\native-host\register.ps1`, `status.ps1`, `unregister.ps1`.

JS-тесты идут на встроенном `node --test`, без зависимостей. Сгенерированный PAC исполняется в изолированном `node:vm` и сверяется с сопоставителем фазы 1.
