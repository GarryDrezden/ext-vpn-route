# Cursor handoff

## Сейчас

- Ветка: `main`.
- Checkpoint commits: `01b9212` (Phase 0A–2), `5aed8e5` (Phase 3). Phase 4 поверх них не закоммичен.
- Phase 0A: **PASS** в Yandex Browser и Chrome.
- Phase 0B: **PASS в Yandex Browser**. Chrome намеренно не тестировался.
- Phase 1: **PASS, автоматические тесты** (доменный слой).
- Phase 2: **PASS, автоматические тесты** (PAC compiler).
- Phase 3: **FULL PASS в Yandex Browser** (production MV3 extension, fixture state).
- Phase 4: production native state transport. **PASS, автоматические тесты**. Ручная проверка необязательна (`docs/phase4-acceptance.md`).
- `npm test`: 330 тестов, все PASS: 107 domain, 56 PAC, 162 extension, 5 integration.
- `npm run test:native-host`: 116 тестов xUnit, все PASS.
- `dist/extension` собран как Fixture (normal). `dist/native-host` опубликован.
- Production host и spike host **не зарегистрированы**.

## Phase 0A — PASS

Цепочка: Manifest V3 → `chrome.proxy` → inline PAC → SOCKS5 logger на `127.0.0.1:17891`.

- В Yandex и Chrome: `levelOfControl=controlled_by_this_extension`, PAC применён, SOCKS5 получает hostname (`ATYP=DOMAIN`), при остановленном logger YouTube не открывается (fail-closed), `example.com` идёт DIRECT.
- QUIC разобран только по NetLog Yandex: реальной `QUIC_SESSION` к YouTube не было. UDP к `[2001:4860:4860::8888]:443` — IPv6 reachability check резолвера, не обход. Для Chrome NetLog не разбирался.
- Edge намеренно пропущен.

Подробно: `docs/phase0-acceptance.md`.

## Phase 0B — PASS в Yandex

Цепочка: popup → service worker → `chrome.runtime.sendNativeMessage` → `com.vpnroute.phase0b` → ping/pong.

- В Yandex: pong валиден, request id сохраняется, `AVAILABLE` только при валидном ответе. После unregister: `ERROR`, `Specified native messaging host not found.`, ложного кэша нет.
- Yandex находит host, когда зарегистрирован **только** `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.vpnroute.phase0b`. Ключ `Software\Chromium` не нужен. `register-native-host.ps1` по умолчанию пишет только Chrome-ключ, `-Target Chromium|All` оставлены для диагностики.
- Extension ID `onodojebmdbcndjelgfhoiffeojngmbd` закреплён полем `key`.
- Host сейчас не зарегистрирован.

Подробно: `docs/phase0b-acceptance.md`.

## Phase 1 — доменный слой

Код: `src/domain/browser-routing/`. Контракт: `docs/browser-routing-contract-v1.md`. Пример состояния: `docs/examples/browser-routing-state-v1.json`.

Стек: plain ES modules + JSDoc, тесты на встроенном `node --test`, ноль зависимостей. В корне `package.json` (`"type": "module"`, скрипт `npm test`). TypeScript и сборщик не введены: модулей пять, контракт фиксируется тестами, а без зависимостей тот же код без сборки грузится в MV3 service worker и в Node.

Модули:

- `constants.js` — enum-значения и лимиты.
- `host.js` — `normalizeHost`, `isCanonicalHost`.
- `issues.js` — коды issues, JSON Pointer.
- `rule.js` — `validateRule`.
- `state.js` — `validateRuleSet`, `validateBrowserRoutingState`.
- `matcher.js` — `compileBrowserRoutingState`, `matchBrowserRoute`.
- `index.js` — публичный API.

Решения:

- IDN переводится в ASCII через WHATWG `URL` host parser (UTS #46). Это стандартный API браузера и Node, не Node-only. До парсера структурные элементы URL отвергаются явно, после него ASCII-результат проверяется строгими правилами меток.
- Обрезка пробелов по краям разрешена и покрыта тестами. Пробелы внутри — ошибка.
- IP-литералы отвергаются: правила только доменные.
- Конфликтом считаются два включённых правила с одинаковыми canonical host и matchType. Дубликат `id` недопустим и среди выключенных.
- `Default` у совпавшего правила останавливает поиск и берёт `defaultRoute`.
- При невалидном состоянии или host результат не содержит `effectiveRoute` (`ok: false`).
- `revision` — JSON-целое `0..2^53-1`.
- `source`: `User` | `System`.

Тесты (`tests/domain/browser-routing/`):

- `host.test.js` — нормализация и все классы отказов.
- `validation.test.js` — правило, набор, состояние, дубликаты и конфликты.
- `matcher.test.js` — exact, domain, приоритет, enabled, `Default`, IDN, fail-safe, чистота.
- `properties.test.js` — seeded-генерация: идемпотентность, граница меток, сверка с brute-force reference, независимость от порядка.
- `contract.test.js` — значения enum, пример состояния, поля MatchResult, граница модуля: в `src/domain` нет `chrome.*`, DOM, Node, сети, времени и случайности.

Мутационная проверка вручную: подмена семантики `Default`, обратный порядок специфичности, отключение конфликтов и снятие удаления завершающей точки — каждая ломает от 4 до 9 тестов.

## Phase 2 — PAC compiler

Код: `src/pac/`. Описание: `docs/pac-compiler-v1.md`.

Модули:

- `compiler.js` — `compilePacScript(state, { proxyHost?, proxyPort })` → `{ ok, script, metadata }` или `{ ok: false, error, issues }`.
- `endpoint.js` — только IPv4 loopback `127.0.0.0/8`, порт `1..65535`.
- `policy.js` — `FORCED_LOCAL_POLICY`, документированный список forced-local адресов.
- `runtime.js` — фиксированный ES5-код PAC.
- `literal.js` — `jsStringLiteral`, ASCII-безопасная сериализация.

Решения:

- VPN — только `SOCKS5 127.0.0.1:<port>`, без `; DIRECT`.
- Порядок решения:
  1. неклассифицируемый host → VPN;
  2. forced-local → DIRECT;
  3. публичный IP-литерал → `defaultRoute`;
  4. ExactHost;
  5. самый длинный DomainAndSubdomains;
  6. `defaultRoute`.
- `Default` подставляется маршрутом `defaultRoute` на этапе compile.
- Forced-local: `localhost`, `*.localhost`, `0/8`, `10/8`, `127/8`, `169.254/16`, `172.16/12`, `192.168/16`, `::`, `::1`, `fc00::/7`, `fe80::/10`, IPv4-mapped по вложенному IPv4. `100.64.0.0/10` сознательно не входит.
- Однометочные имена следуют правилам. `isPlainHostName` не используется.
- В PAC нет DNS-функций и PAC-помощников. Не-ASCII host не сопоставляется приблизительно и идёт в VPN.
- Таблица — object literal с ключами `e:`/`d:` и `hasOwnProperty`. Lookup — проход по суффиксам.
- PAC детерминирован: от порядка правил и display-полей не зависит. `revision` — только в заголовке-комментарии.

Тесты (`tests/pac/`):

- `runtime.test.js` — матрица маршрутов, forced-local и соседние публичные адреса, fail-closed.
- `compiler.test.js` — API, endpoint, детерминизм, escaping, статические проверки no-DNS и ES5, граница модуля, 10000 правил.
- `differential.test.js` — seeded сверка с Phase 1 matcher (seed `20261003`): 600 состояний и 102 584 сравнения хостов. Плюс 12 000 сравнений IP-литералов с независимым `net.BlockList`.

PAC исполняется в `node:vm`. Обращение к DNS-функциям и PAC-помощникам ловушками роняет тест.

Мутационная проверка: 12 внесённых ошибок в runtime, compiler и endpoint ловятся, каждая — от 1 до 32 тестов.

Замеры (`npm run measure:pac`):

| Правил | Размер PAC | Compile |
|---|---|---|
| 0 | 4.3 KiB | 0.03 ms |
| 1000 | 34 KiB | 4 ms |
| 10000 | 315 KiB | 48 ms |

Lookup около 3 µs в vm Node и практически не зависит от числа правил.

## Phase 3 — production extension runtime, FULL PASS в Yandex

Код: `src/extension/`. Подробно: `docs/phase3-extension-runtime.md`. Результаты и инструкция: `docs/phase3-acceptance.md`.

Подтверждено в Yandex:

- normal fixture `APPLIED` 3001 с read-back `data_match` (Yandex возвращает `pacScript.data`);
- DIRECT для `example.com`, fail-closed для YouTube;
- SOCKS5 `ATYP=DOMAIN`;
- Clear / Reapply;
- large PAC 382165 bytes `APPLIED` 3999 `data_match`.

Перед проверкой production extension Phase 0 Spike должен быть выключен и не оставлять active PAC. Иначе после production Clear эффективным становится PAC spike.

- Цепочка: fixture `state/smoke-state.js` (revision 3001; `youtube.com` и `googlevideo.com` → VPN, `example.com` ExactHost → Direct, по умолчанию Direct) → `compilePacScript` с endpoint из `runtime/config.js` (`127.0.0.1:17891`, Phase 0 logger) → `proxy.settings.set` с `mandatory: true` → read-back.
- Production extension ID: `lfaekfalhkgmbfdjjlfcalanhijeaien`. Отличается от spike, приватный ключ не сохранён.
- Permissions: `proxy`, `storage`.
- Сборка: `npm run build:extension` собирает `dist/extension` (в `.gitignore`), раскладка повторяет `src/`. `npm run build:extension:large` — dev-only, 10000 правил, revision 3999, PAC 382165 bytes.
- `runtime/proxy-controller.js` — state machine, chrome API передаются явно:
  - статусы: `IDLE`, `APPLYING`, `APPLIED`, `NOT_APPLIED`, `ERROR`, `CONFLICT`, `NOT_CONTROLLABLE`, `UNAVAILABLE`;
  - `active.pac`: `CURRENT`, `PREVIOUS`, `UNRECOGNIZED`, `NONE`, `UNKNOWN`.
- Чужая proxy-политика не перезаписывается.
- `APPLIED` ставится только после read-back: `controlled_by_this_extension`, `pac_script`, `mandatory`, совпадение `data` (`data_match`) или отсутствие `data` (`data_unavailable`).
- Ошибка compile, `set` или read-back не очищает прокси и не ставит DIRECT. Last known good PAC остаётся и показывается как `PREVIOUS`. Без PAC: `ERROR` и «routing is NOT protected».
- Clear выполняется только по кнопке.
- Apply срабатывает на `onInstalled`, `onStartup` и по кнопке Reapply. Polling нет.
- В storage хранится только диагностика (`vpnRouteDiagnostics`).

Тесты (`tests/extension/`):

- `proxy-controller.test.js` — state machine на fake `chrome.proxy`.
- `background.test.js` — service worker с mock `chrome` в callback-стиле, включая `runtime.lastError` и фильтр отправителя.
- `build.test.js` — состав сборки, manifest, ID, импорты, запреты, fixtures, 16 вариантов испорченной сборки.

Мутационная проверка: 13 внесённых ошибок в controller, adapter, worker и build ловятся.

## Phase 4 — production native state transport

Подробно: `docs/phase4-native-state-transport.md`. Протокол: `docs/native-messaging-protocol-v1.md`.

Цепочка: Native build extension → `sendNativeMessage("com.vpnroute.browser", getState)` → `SelectiveVpnRouter.NativeHost.exe` → `IServiceStateClient`. Service не подключён: production-клиент `UnavailableServiceStateClient` всегда отвечает `service_unavailable`.

- Host: `src/native-host/`, net10.0, без NuGet.
  - Publish: `npm run build:native-host` → `dist/native-host/SelectiveVpnRouter.NativeHost.exe`, self-contained single file win-x64, 73 553 737 bytes, без trimming (trimmed — 12.5 MiB, отложено).
  - Команды: `ping` и `getState`.
  - Проверяет origin по argv и `--parent-window`.
  - Лимиты: запрос 64 KiB, ответ 1 MiB.
  - Stdout — только кадры, логи — в stderr.
- Регистрация: `scripts/native-host/{register,unregister,status}.ps1`.
  - Только HKCU Chrome-ключ, manifest в `dist/native-messaging/`.
  - Origin ровно `chrome-extension://lfaekfalhkgmbfdjjlfcalanhijeaien/`.
  - Ключи spike не трогаются.
- Extension, режим фиксируется при сборке:
  - `build:extension` / `:large` — Fixture, permissions `proxy` + `storage`;
  - `build:extension:native` — Native, плюс `nativeMessaging`, без fixture-модуля.
- `state/native-state-provider.js`:
  - таймаут 5 s;
  - строгий конверт, `requestId`, `protocolVersion`;
  - state через Phase 1, endpoint через Phase 2.
- `state/snapshot.js` — `BrowserRoutingSnapshot { state, proxyEndpoint }`.
- `runtime/routing-coordinator.js` — revision policy:
  - stale `<` applied отклоняется;
  - `==` — unchanged без `set`;
  - `>` — apply.
- Fail-safe: при ошибке нет clear, DIRECT и fixture fallback, действует last-known-good. Routing protection: `CURRENT` / `LAST_KNOWN_GOOD` / `NOT_PROTECTED`.
- Proxy controller Phase 3 расширен: `apply(reason, snapshot?)`, опциональный `loadState`, `read()`.
- Storage: `vpnRouteDiagnostics` и `vpnRouteStateSource` (lineage + диагностика транспорта), правил нет.
- Мутационная проверка: 27 внесённых ошибок ловятся (17 extension и build, 10 host).

## Файлы

- `spike/` — Phase 0, в продукт не переносится: `extension/`, `socks5-logger/`, `native-host/`, `native-host-tests/`.
- `src/domain/browser-routing/`, `tests/domain/browser-routing/` — Phase 1.
- `src/pac/`, `tests/pac/`, `scripts/measure-pac.js` — Phase 2.
- `src/extension/`, `tests/extension/`, `scripts/build-extension.js`, `scripts/large-fixture.js`, `scripts/extension-id.js` — Phase 3–4. `dist/` генерируется.
- `src/native-host/`, `tests/native-host/`, `tests/integration/`, `scripts/build-native-host.js`, `scripts/native-host/` — Phase 4.
- `docs/phase0-acceptance.md`, `docs/phase0b-acceptance.md`, `docs/browser-routing-contract-v1.md`, `docs/pac-compiler-v1.md`, `docs/phase3-extension-runtime.md`, `docs/phase3-acceptance.md`, `docs/native-messaging-protocol-v1.md`, `docs/phase4-native-state-transport.md`, `docs/phase4-acceptance.md`, `docs/examples/`.

## Автоматические проверки

Из корня репозитория:

```text
npm test
npm run test:native-host
npm run build:extension:native
npm run build:extension:large
npm run build:native-host -- --tests
npm run build:extension
dotnet build spike\socks5-logger\Socks5Logger.csproj
dotnet build spike\native-host\SelectiveVpnRouter.NativeHost.Spike.csproj -c Release
dotnet build spike\native-host-tests\NativeHostProtocolTests.csproj -c Release
dotnet spike\native-host-tests\bin\Release\net8.0\NativeHostProtocolTests.dll spike\native-host\bin\Release\net8.0\SelectiveVpnRouter.NativeHost.Spike.exe
dotnet run --project spike\socks5-logger\Socks5Logger.csproj -- --self-test
```

## Ограничения

- IDNA зависит от реализации `URL` в runtime. Канонические ASCII-формы обычных доменов совпадают, но для экзотических Unicode-символов Node и конкретная версия Chromium теоретически могут разойтись. Контракт требует, чтобы по проводу ходил уже canonical ASCII.
- Корректность Punycode в метках `xn--` проверяет `URL` парсер runtime, своего декодера нет.
- Однометочные host и TLD-правила (`ru`) допустимы. Public Suffix List не применяется; выбор «домен целиком» для UI — задача будущего popup.
- Как Chromium передаёт в PAC IPv6 host, не проверено.
- `scope: "regular"`, инкогнито не настраивается.
- Неклассифицируемый host идёт в VPN даже при `defaultRoute = Direct` (fail-closed).
- Native: Service connector отсутствует, production `getState` всегда `service_unavailable`. Успешный путь проверен только с fake Service и fake host.
- Production host в браузере не запускался; это необязательный `docs/phase4-acceptance.md`.
- Лимит Chromium 1 MiB на ответ host: около 10000 правил в JSON не помещаются (`response_too_large`). Нужен компактный формат или разбиение.
- Revision lineage без epoch: сброс ревизии на стороне Service приведёт к `stale_snapshot`. Выход — явный Clear.
- Exe не подписан. Manifest указывает абсолютный путь в рабочую копию.
- `connectNative` не используется и не проверялся.

## Архитектурные правила

- VPN Route Service — единственный authoritative source of truth для правил.
- Native host — тупой bridge: правил не хранит и не кэширует, файлы, реестр, сеть и процессы не трогает.
- Extension владеет proxy/PAC в Chromium и получает состояние от Service. Правил в `chrome.storage` нет.
- TabDock позже станет вторым клиентом того же контракта. Сейчас не трогается.
- Обход localhost/private/link-local и маршрут для IP-литералов — forced-local policy PAC-компилятора, не matcher и не BrowserRoutingRule.
- В модели нет fallback на DIRECT. VPN в PAC — только `SOCKS5 127.0.0.1:<port>` без `; DIRECT`.
- PAC не использует DNS.

## Не начато

- Service connector в host (named pipe к VPN Route Service) и `getState` на стороне Service.
- `upsertRule` / `deleteRule`, UI правил, push-обновления (`connectNative`).
- ExplicitBrowserProxy, VPN-side DNS, TabDock, Portable Bootstrap и установщик.
- Изменения `Vpn-gateway`.
