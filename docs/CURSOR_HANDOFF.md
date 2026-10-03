# Cursor handoff

## Сейчас

- Ветка: `main`
- HEAD: `0a7830a8a06f9ee5da0f1468f53d7f2e2d11e3dc`. Ничего после него не коммитилось.
- Phase 0A: **PASS** в Yandex Browser и Chrome.
- Phase 0B: **PASS в Yandex Browser**. Chrome намеренно не тестировался.
- Phase 1: доменный слой реализован.
- Phase 2: PAC compiler реализован, через `chrome.proxy` не применяется.
- `npm test`: 163 теста, все PASS (107 Phase 1, 56 Phase 2). Браузерной проверки у Phase 1 и 2 нет.
- Phase 3 не начат.

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

## Файлы

- `spike/` — Phase 0, в продукт не переносится: `extension/`, `socks5-logger/`, `native-host/`, `native-host-tests/`.
- `src/domain/browser-routing/`, `tests/domain/browser-routing/` — Phase 1.
- `src/pac/`, `tests/pac/`, `scripts/measure-pac.js` — Phase 2.
- `docs/phase0-acceptance.md`, `docs/phase0b-acceptance.md`, `docs/browser-routing-contract-v1.md`, `docs/pac-compiler-v1.md`, `docs/examples/`.

## Автоматические проверки

Из корня репозитория:

```text
npm test
dotnet build spike\native-host\SelectiveVpnRouter.NativeHost.Spike.csproj -c Release
dotnet build spike\native-host-tests\NativeHostProtocolTests.csproj -c Release
dotnet spike\native-host-tests\bin\Release\net8.0\NativeHostProtocolTests.dll spike\native-host\bin\Release\net8.0\SelectiveVpnRouter.NativeHost.Spike.exe
dotnet run --project spike\socks5-logger\Socks5Logger.csproj -- --self-test
```

## Ограничения

- IDNA зависит от реализации `URL` в runtime. Канонические ASCII-формы обычных доменов совпадают, но для экзотических Unicode-символов Node и конкретная версия Chromium теоретически могут разойтись. Контракт требует, чтобы по проводу ходил уже canonical ASCII.
- Корректность Punycode в метках `xn--` проверяет `URL` парсер runtime, своего декодера нет.
- Однометочные host и TLD-правила (`ru`) допустимы. Public Suffix List не применяется; выбор «домен целиком» для UI — задача будущего popup.
- В браузерном runtime доменный модуль и compiler ещё не загружались, только в Node.
- Сгенерированный PAC исполнялся только в `node:vm`, не в PAC-движке Chromium. В браузере не проверено: передаёт ли Chromium IPv6 host со скобками и как ведёт себя inline PAC размером ~315 KiB.
- Неклассифицируемый host идёт в VPN даже при `defaultRoute = Direct` (fail-closed).
- Phase 0B проверен только `sendNativeMessage`; долгоживущий `connectNative` в браузере не проверялся.

## Архитектурные правила

- VPN Route Service — единственный authoritative source of truth для правил.
- Native host — тупой bridge, правил не хранит.
- Extension владеет proxy/PAC в Chromium и получает состояние от Service.
- TabDock позже станет вторым клиентом того же контракта. Сейчас не трогается.
- Обход localhost/private/link-local и маршрут для IP-литералов — forced-local policy PAC-компилятора, не matcher и не BrowserRoutingRule.
- В модели нет fallback на DIRECT. VPN в PAC — только `SOCKS5 127.0.0.1:<port>` без `; DIRECT`.
- PAC не использует DNS.

## Не начато

- Phase 3 и дальше: применение PAC через `chrome.proxy`, production Native Messaging, IPC с Service, ExplicitBrowserProxy, VPN-side DNS, UI правил, persistence, TabDock, Portable Bootstrap.
- Изменения `Vpn-gateway`.
