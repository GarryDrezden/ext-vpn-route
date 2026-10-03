# Phase 4 — production native state transport

Цепочка:

```text
MV3 extension (Native build)
  └─ chrome.runtime.sendNativeMessage("com.vpnroute.browser", getState)
       └─ SelectiveVpnRouter.NativeHost.exe  (production host, src/native-host/)
            └─ IServiceStateClient
                 └─ VPN Route Service        (в Phase 4 НЕ подключён: UnavailableServiceStateClient)
```

Протокол: `docs/native-messaging-protocol-v1.md`.

## Роли

- **VPN Route Service** — единственный authoritative source `BrowserRoutingState`. В Phase 4 не меняется.
- **Native host** — тупой bridge:
  - проверяет origin вызывающего;
  - разбирает кадр;
  - вызывает `IServiceStateClient`;
  - передаёт `state` без изменений.

  Правил не хранит, не кэширует, не читает файлы, реестр и переменные окружения, не открывает сеть и не запускает процессы.
- **Extension** — потребитель состояния и владелец PAC:
  - валидирует snapshot;
  - применяет revision policy;
  - компилирует PAC и применяет его через `chrome.proxy`.

  Правила в `chrome.storage` не хранятся.
- **TabDock** — будущий второй клиент того же контракта. Не трогается.

## Native host

| | |
|---|---|
| Проект | `src/native-host/SelectiveVpnRouter.NativeHost.csproj`, net10.0 (LTS до ноября 2028), без NuGet-зависимостей |
| Host name | `com.vpnroute.browser` (spike: `com.vpnroute.phase0b`, не пересекается) |
| Allowed origin | `chrome-extension://lfaekfalhkgmbfdjjlfcalanhijeaien/` |
| Publish | `dist/native-host/SelectiveVpnRouter.NativeHost.exe` — self-contained, single file, win-x64, без trimming, ~70 MiB |
| Тесты | `tests/native-host/` (xUnit), 116 |

Почему net10.0, хотя spike на net8.0:

- поддержка .NET 8 заканчивается в ноябре 2026;
- .NET 10 — текущий LTS;
- SDK 10 и runtime pack уже есть в окружении;
- spike не меняется.

Структура:

- `Program.cs`:
  - открывает stdin/stdout;
  - перенаправляет `Console.Out` в stderr, чтобы случайный вывод не испортил кадры;
  - запускает `NativeHostApp`.
- `NativeHostApp.cs`:
  - проверка origin;
  - цикл кадров;
  - коды выхода: 0 EOF, 1 fatal, 2 too large, 3 truncated, 4 forbidden origin.
- `Protocol/`:
  - `FrameReader` / `FrameWriter` — собственная реализация framing, без ссылки на spike;
  - `RequestDispatcher` — строгий конверт, `ping`, `getState`, таймаут Service 3 s, лимит ответа 1 MiB;
  - `ResponseWriter` — фиксированные сообщения ошибок;
  - `ProtocolV1` — константы.
- `Service/`:
  - `IServiceStateClient.GetStateAsync` → `ServiceStateSnapshot(JsonElement State, ProxyEndpoint)`;
  - `UnavailableServiceStateClient` — production-реализация Phase 4.
- `Security/CallerOrigin.cs` — проверка argv.

Trimming измерен, но не включён:

- trimmed single file весит 12.5 MiB против 70.1 MiB, smoke и 116 тестов проходят и на trimmed-бинаре;
- успешный `getState` с реальным Service через trimmed-сборку пока не исполнялся: production-клиент всегда недоступен;
- включать вместе с Service connector, когда success-путь пройдёт через реальный бинарь.

## Сборка

| Команда | Результат |
|---|---|
| `npm run build:extension` | Fixture build (normal), permissions `proxy`, `storage`. Default. |
| `npm run build:extension:large` | Fixture build (large, 10000 правил). Dev-only. |
| `npm run build:extension:native` | Native build, permissions `nativeMessaging`, `proxy`, `storage`. |
| `npm run build:native-host` | `dotnet publish` в `dist/native-host`, проверка состава, protocol smoke. Реестр не трогает. |
| `npm run build:native-host -- --tests` | То же плюс весь xUnit suite против опубликованного exe. |
| `npm run test:native-host` | xUnit suite против build output. |

Режим источника состояния фиксируется при сборке, а не runtime-флагом:

- `src/extension/state/source.js` — Fixture source, по умолчанию.
- `src/extension/state/source-native.js` — Native source. Native build копирует его в `extension/state/source.js`.

Native build не содержит `smoke-state.js`, и ни один модуль не ссылается на fixture. Fallback на fixture физически невозможен.

Fixture build не содержит `native-state-provider.js`, `snapshot.js`, `source-native.js`.

Валидация сборки (`validateExtension`):

- permissions ровно по режиму;
- `sendNativeMessage` и `nativeMessaging` встречаются только в `extension/state/native-state-provider.js` и только в Native build;
- `connectNative`, `chrome.tabs`, `chrome.scripting`, `chrome.webRequest`, `setInterval`, `chrome.alarms`, `eval`, `new Function`, `fetch`, remote URL запрещены всегда;
- host name в `config.js` = `com.vpnroute.browser`;
- `STATE_SOURCE` в собранном `source.js` соответствует режиму.

Каждая сборка полностью очищает свой out-каталог.

## Регистрация (HKCU, без UAC)

```text
powershell -ExecutionPolicy Bypass -File scripts\native-host\register.ps1      # Chrome-ключ, по умолчанию
powershell -ExecutionPolicy Bypass -File scripts\native-host\status.ps1
powershell -ExecutionPolicy Bypass -File scripts\native-host\unregister.ps1    # оба ключа, идемпотентно
```

- Ключ: `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.vpnroute.browser`. Yandex находит host по Chrome-ключу (проверено в Phase 0B). Chromium-ключ — только через `-Target Chromium|All`.
- Manifest генерируется локально в `dist\native-messaging\com.vpnroute.browser.json`:
  - UTF-8 без BOM, не-ASCII в пути экранируется `\uXXXX`;
  - абсолютный путь к `dist\native-host\SelectiveVpnRouter.NativeHost.exe`;
  - `allowed_origins` из одного точного origin;
  - лежит вне `dist\native-host`, поэтому пересборка host его не стирает.
- `register.ps1`:
  - вычисляет extension ID из `key` в `src/extension/manifest.json` и сверяет с ожидаемым;
  - после записи проверяет manifest и registry read-back.
- `unregister.ps1` удаляет только ключи `com.vpnroute.browser`. Manifest удаляется, когда на него не ссылается ни один ключ.
- `status.ps1`:
  - показывает host name, protocol version, origin, exe, manifest и ключи;
  - проверяет поля manifest, точный origin и отсутствие wildcard и BOM;
  - при несогласованности выходит с кодом 1.
- `Assert-ProductionSubKey` отказывается трогать любой ключ, кроме `...\NativeMessagingHosts\com.vpnroute.browser`. Ключи spike не трогаются.

## Extension

### `BrowserRoutingSnapshot` (`state/snapshot.js`)

`{ state: BrowserRoutingStateV1, proxyEndpoint: { host, port } }`. Метаданные Service и транспорта в `state` не смешиваются. `createBrowserRoutingSnapshot` проверяет точную форму, Phase 1 state и Phase 2 endpoint, а возвращает замороженный canonical snapshot.

### `NativeStateProvider` (`state/native-state-provider.js`)

- `getState()` → `{ ok: true, snapshot, requestId, at, transport, service }` или `{ ok: false, error: { code, message, hostErrorCode }, transport, service }`.
- Таймаут 5 s. Поздний ответ после таймаута игнорируется.
- Транспортные коды (`transport: ERROR`): `host_not_found`, `access_forbidden`, `host_exited`, `transport_error`, `timeout`, `malformed_response`, `unsupported_protocol`, `request_id_mismatch`.
- Ответ host с `ok: false` даёт `host_error` с `hostErrorCode`. `service_*` означает `service: UNAVAILABLE`.
- Невалидные данные (`transport: AVAILABLE`, `service: AVAILABLE`): `invalid_snapshot`, `invalid_state`, `invalid_endpoint`.
- Не применяет PAC, не пишет proxy и storage, не хранит правила.

### `RoutingCoordinator` (`runtime/routing-coordinator.js`)

Native: `provider.getState()` → валидный snapshot → revision policy → `controller.apply(reason, snapshot)`.

Fixture: `controller.apply(reason)`, поведение Phase 3 без изменений.

Proxy controller Phase 3 расширен минимально:

- `apply(reason, snapshot?)`;
- `loadState` / `endpoint` опциональны;
- `read()`;
- без встроенного state референсом CURRENT после рестарта worker служит последний успешный apply (header revision + длина), если в этом worker ещё не было compile.

### Revision policy

Сравнение идёт с `lineage.lastAppliedRevision` — последней ревизией Service, успешно применённой в Native mode.

| Входящая ревизия | Действие |
|---|---|
| нет применённой | apply |
| `<` applied | отклонить, `stale_snapshot`; PAC не трогается |
| `==` applied, тот же endpoint, PAC действует и проверен (`CURRENT`) | `unchanged`, без `proxy.set` |
| `==` applied, но endpoint другой или PAC не действует | повторный apply |
| `>` applied | apply |

Сценарий из тестов:

1. 42 и 43 применяются.
2. Fetch 44 падает — остаётся 43.
3. Пришедший потом 42 отклоняется как stale.
4. 44 применяется.

Допущение монотонности: в пределах одной lineage Service ревизия только растёт, и одна ревизия означает одно и то же состояние. Epoch и UUID lineage в Phase 4 нет.

Следствия:

- если Service сбросит ревизию, например при потере хранилища, extension будет отвергать его состояние как stale;
- явный Clear сбрасывает lineage, и следующий snapshot принимается с любой ревизией;
- одинаковая ревизия с другим содержимым не обнаруживается, это нарушение контракта Service.

Lineage хранится в `vpnRouteStateSource`: это диагностика, правил там нет. Fixture-сборки lineage не трогают, поэтому переход fixture → native не блокируется ревизией fixture 3001.

### Fail-safe

При любой ошибке получения или проверки состояния:

- нет `clear`;
- нет DIRECT-only PAC;
- нет fallback на fixture и на настройку браузера по умолчанию;
- последний применённый PAC остаётся (last-known-good).

Ошибка compile, `set` или read-back обрабатывается controller'ом Phase 3 так же.

Routing protection:

| Значение | Когда |
|---|---|
| `CURRENT` | действует PAC этого extension (`CURRENT`), статус `APPLIED`, последний fetch успешен и его ревизия = действующей |
| `LAST_KNOWN_GOOD` | действует ранее применённый PAC, но последний fetch, apply или проверка не прошли или ревизия отличается |
| `NOT_PROTECTED` | PAC этого extension не действует (`NONE`, `UNRECOGNIZED`, `UNKNOWN`), например PAC ещё ни разу не применялся |

### Lifecycle

- `onInstalled`, `onStartup` → `coordinator.sync`.
- Popup: кнопка «Refresh state & apply» (в Fixture — «Reapply PAC»), «Clear extension proxy», «Refresh status».
- Без polling, `setInterval`, alarms, reconnect и `connectNative`.
- Открытие popup не обращается к host: `status` только читает proxy и storage.

### Popup (Native)

State source, Routing protection, Native host, Transport, Protocol, Service, Last state fetch, Fetched revision, Last decision, Last transport error. Плюс поля Phase 3: State, PAC, Applied revision, Active PAC, Read-back.

Правила и hostnames не показываются.

## Тесты

- Node (`npm test`) — 330:
  - 107 domain;
  - 56 PAC;
  - 162 extension: controller 29, background 2, build 41, provider 55, coordinator 33, popup 2;
  - 5 integration (контракт host name / origin / protocol между C#, PowerShell и extension; registration scripts).
- xUnit (`tests/native-host/`) — 116:
  - Framing 22;
  - Security 27;
  - Service 23;
  - Contract 24;
  - Process 8 (реальный exe);
  - SourceSecurity 12 (запрет сети, pipe, процессов, файлов, реестра, env, reflection в исходниках host).
- Smoke (`npm run build:native-host`) на опубликованном exe: `ping`, `getState` → `service_unavailable`, `unknown_command`, `forbidden_origin` для spike origin и без origin. Плюс production `NativeStateProvider` через транспорт «процесс на сообщение», как у Chromium.
- Мутационная проверка: 27 внесённых ошибок (17 в extension и build, 10 в host) ловятся.

## Ограничения

- Service connector не реализован: production `getState` всегда `service_unavailable`. Успешный путь проверен только с fake Service (in-process) и fake host (extension).
- В браузере проверен только Phase 0B ping через spike host. Production host в браузере не запускался, это необязательный `docs/phase4-acceptance.md`.
- 1 MiB на ответ host: состояние около 10000 правил в JSON больше лимита. Host отвечает `response_too_large`; в тестах 3000 правил проходят, 10000 — нет. Для больших наборов нужен компактный формат или разбиение — решение фазы Service.
- Lineage без epoch (см. выше).
- После рестарта worker, пока нет нового apply, read-back сверяется по header revision + длине (`header_and_length`), а не по полному тексту PAC.
- Exe не подписан. Путь в manifest абсолютный и указывает в рабочую копию репозитория (portable-dev). Установщика нет.
