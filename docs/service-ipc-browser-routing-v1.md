# Service IPC: browser routing v1

Локальный IPC между production native host (`SelectiveVpnRouter.NativeHost.exe`, этот репозиторий) и VPN Route Service (`Vpn-gateway`).

Код Service: `Vpn-gateway/src/SelectiveVpnRouter.Core/BrowserRouting/`, хост в службе — `src/SelectiveVpnRouter.Service/BrowserRoutingPipeHost.cs`. Код клиента: `src/native-host/Service/`.

Версия IPC (`version: 1`) не зависит от версии Native Messaging (`protocolVersion: 1`). Они меняются независимо.

## Почему отдельный endpoint

У Service уже есть pipe `\\.\pipe\SelectiveVpnRouter` (`IpcRequest{Version,Id,Method,PayloadJson}`). Переиспользовать его нельзя:

- **Нет авторизации по методам.** Любой Authenticated User вызывает `SetConfig`, `ConnectVpn`, `EmergencyRestore`. Host, подключённый к этому pipe, технически может вызвать любой метод, а allowlist держался бы только на дисциплине клиента.
- **ACL шире нужного.** Там AuthenticatedUsers ReadWrite.
- **Нет машинных кодов ошибок.** В ответ уходит `ex.Message`. Это утечка деталей и невозможность различить `snapshot_changed` и `browser_state_unavailable`.

Поэтому выбран отдельный read-only endpoint с allowlist на стороне сервера. Framing тот же (Int32 LE + UTF-8 JSON), второго «стиля» транспорта нет.

## Endpoint

| | |
|---|---|
| Pipe | `\\.\pipe\SelectiveVpnRouter.BrowserRouting` |
| Методы | ровно `getManifest`, `getPage` |
| Соединение | один запрос на соединение: кадр запроса → кадр ответа → disconnect |
| Запрос | ≤ 4 KiB |
| Ответ | ≤ 512 KiB (`MaxResponseBytes`) |
| Параллельно | до 4 клиентов, таймаут клиента 5 s |
| Сеть | нет: ни TCP, ни localhost-порта |

### Безопасность pipe

DACL защищённый, без наследования:

- SYSTEM, Administrators и создатель (учётка службы): FullControl;
- INTERACTIVE: ReadWrite, без права создавать экземпляры;
- NETWORK: Deny;
- Everyone / Anonymous / Authenticated Users / Users ничего не получают.

Первый экземпляр создаётся с `FirstPipeInstance`. Если имя уже занято (squatting), служба отказывается обслуживать и не делит pipe с чужим процессом.

Клиент (host):

- подключается с `TokenImpersonationLevel.Identification`: сервер может узнать, кто клиент, но не может действовать от его имени;
- после подключения проверяет владельца pipe: SYSTEM, Administrators или текущий пользователь. Иначе `service_untrusted`, запрос не отправляется;
- connect timeout 1 s → `service_unavailable`, общий таймаут вызова 3 s → `service_timeout`. Reconnect-цикла нет.

Сервер не делает `ImpersonateNamedPipeClient` / `RunAsClient`.

## Кадр

```text
Int32 LE длина (1..max) + UTF-8 JSON
```

Длина вне диапазона, EOF посреди кадра, не-JSON — клиент получает `invalid_service_response`.

## Запрос

```json
{ "version": 1, "id": "550e8400-e29b-41d4-a716-446655440000", "method": "getManifest" }
```

```json
{
  "version": 1,
  "id": "req-2",
  "method": "getPage",
  "params": { "stateGeneration": "75f5c435-6ac5-45a5-876b-042a6376635e", "revision": 0, "startIndex": 0 }
}
```

- Поля ровно эти. Лишние, повторяющиеся или отсутствующие — `invalid_request`.
- `id` — `[A-Za-z0-9._:-]{1,128}`. Host передаёт `requestId` из Native Messaging как correlation id.
- `params` у `getPage` — ровно `{stateGeneration, revision, startIndex}`, у `getManifest` их нет.
- Метод вне allowlist (`SetConfig`, `ConnectVpn`, …) — `unknown_method`. Имя в ответ и в лог не попадает.

## Ответ

```json
{ "version": 1, "id": "<как в запросе>", "ok": true, "result": { } }
{ "version": 1, "id": "<как в запросе или null>", "ok": false, "error": { "code": "snapshot_changed" } }
```

В `error` только `code`. Текстов исключений, путей и stack trace нет.

| code | Когда |
|---|---|
| `invalid_request` | конверт или params не по схеме |
| `unsupported_version` | `version` ≠ 1 |
| `unknown_method` | метод вне allowlist |
| `browser_state_unavailable` | state не загружен: файл повреждён, `.bak` без основного файла, неподдерживаемая версия документа, ошибка чтения |
| `snapshot_changed` | `{stateGeneration, revision}` в запросе не совпадает с текущим |
| `invalid_cursor` | `startIndex ≥ ruleCount` |
| `internal_error` | непредвиденная ошибка; деталей нет |

## `getManifest`

```json
{
  "schemaVersion": 1,
  "stateGeneration": "75f5c435-6ac5-45a5-876b-042a6376635e",
  "revision": 0,
  "defaultRoute": "Direct",
  "ruleCount": 0,
  "pageBudgetBytes": 520192,
  "browserProxy": { "status": "Unavailable", "endpoint": null }
}
```

- `stateGeneration` — UUID в нижнем регистре (`D`-формат). Создаётся Service, хранится вместе с state, переживает рестарт.
- `ruleCount` — `0..10000`.
- `pageBudgetBytes` = 512 KiB − 4 KiB резерва на конверт.
- `browserProxy`:
  - `{ "status": "Ready", "endpoint": { "host": "127.x.y.z", "port": 1..65535 } }`, если Service поднял explicit browser proxy;
  - иначе `{ "status": "Unavailable", "endpoint": null }`.

  В Phase 5 explicit browser proxy в Service нет, production всегда отвечает `Unavailable`. `Ready` бывает только у тестового Service stand-in.

## `getPage`

```json
{
  "stateGeneration": "75f5c435-6ac5-45a5-876b-042a6376635e",
  "revision": 12,
  "startIndex": 0,
  "nextIndex": 1873,
  "rules": [ { "id": "…", "name": "…", "host": "…", "matchType": "…", "routeMode": "…", "enabled": true, "source": "User", "notes": null } ]
}
```

- Правила отсортированы по `id` (ordinal). Порядок детерминирован, байты страницы при одном state одинаковы.
- Страница содержит минимум одно правило. Правила добавляются, пока сериализованный массив помещается в `pageBudgetBytes`. Одно правило ≤ 8 KiB (`MaxRuleBytes`), поэтому лимит не нарушается никогда.
- `nextIndex` — индекс следующей страницы или `null` на последней.
- Курсор — целое `0 ≤ startIndex < ruleCount`. Для пустого state страниц нет, клиент их не запрашивает.
- Identity не совпадает — `snapshot_changed`. Клиент начинает заново с `getManifest`.

### Бюджет

| | |
|---|---|
| Худшее правило (id 64, name 120 × кириллица, host 253, notes 1000 × кириллица, JSON-escape `\uXXXX`) | ≈ 7.3 KB |
| Страниц для 10000 худших правил | ≤ 159 (измерено: 139) |
| `MaxPagesPerSnapshot` | 160 |

512 KiB ответа Service + конверт Native Messaging заведомо меньше лимита Chromium 1 MiB на сообщение host → browser. Ни обрезки, ни сжатия, ни снижения лимита 10000 нет.

## Хранение state в Service

Файл `%ProgramData%\SelectiveVpnRouter\browser-routing-state.json`. Он отдельный от `config.json`, потому что `SetConfig` из UI перезаписывает config целиком.

```json
{
  "documentType": "VpnRoute.BrowserRoutingState",
  "documentVersion": 1,
  "stateGeneration": "…",
  "schemaVersion": 1,
  "revision": 0,
  "defaultRoute": "Direct",
  "rules": []
}
```

- **Начальное состояние** (нет ни файла, ни `.bak`): новый generation, revision 0, Direct, `rules: []`. Seed-правил нет. Сохраняется до того, как будет отдано.
- **Атомарная запись:** `.tmp` с WriteThrough + flush, затем `File.Replace(tmp, path, .bak.json)`. При ошибке `.tmp` удаляется, в памяти остаётся прежний state. Ошибка persistence state не сбрасывает.
- **Повреждение или ошибка валидации:** `browser_state_unavailable`, файл не трогается. Молча подставить пустой Direct нельзя.
- **`.bak` есть, основного файла нет:** `browser_state_unavailable`, не initial state.
- **Документ без `documentType`/`documentVersion`/`stateGeneration`:** миграция с новым generation, revision и правила сохраняются.
- **`stateGeneration` меняется** только при первом создании, явном reset и деструктивной миграции.

Host-имена в state — только canonical ASCII. Service проверяет это сам: метки `[a-z0-9_-]`, `xn--` через `IdnMapping` round-trip, числовой TLD запрещён. Второй UTS #46 движок не пишется. Совпадение JS и C# валидаторов закреплено общими golden vectors: `contracts/browser-routing-v1/golden-vectors.json`, побайтовая копия в `Vpn-gateway/tests/contracts/`.

## Логи

Service пишет `browser-routing {method}: {result}`. Host пишет команду, результат и размер. Хосты, правила и тексты исключений не логируются.

## Test seam

Native host читает одну переменную окружения: `VPN_ROUTE_TEST_SERVICE_PIPE`.

- Принимается только `SelectiveVpnRouter.BrowserRouting.Test.<32 hex>`.
- Любое другое значение отключает подключение: `service_unavailable`, в stderr `override rejected`.
- Проверка владельца pipe действует и для тестового имени.

Зачем нужен: cross-process тесты идут рядом с работающей службой, которая держит production-имя. Новых возможностей переменная не даёт. Поднять pipe в тестовом пространстве может только тот же пользователь, а его pipe проверка владельца и так допускает.
