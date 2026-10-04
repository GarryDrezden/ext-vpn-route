# Native Messaging protocol v1

Протокол между production extension (`lfaekfalhkgmbfdjjlfcalanhijeaien`) и production native host `com.vpnroute.browser` (`SelectiveVpnRouter.NativeHost.exe`).

Код host: `src/native-host/`. Код клиента: `src/extension/state/native-state-provider.js`. Связь host ↔ Service: `docs/service-ipc-browser-routing-v1.md`.

## Транспорт

- Chromium Native Messaging, `stdio`.
- Кадр: 4 байта длины little-endian + UTF-8 JSON.
- Клиент вызывает `chrome.runtime.sendNativeMessage`: одно сообщение — один процесс host. `connectNative` не используется.
- stdout host содержит **только** кадры. Диагностика — только stderr (`[native-host] ...`).
- Лимит запроса: 64 KiB. Больше — `message_too_large`, host завершается без чтения payload.
- Лимит ответа: 1 MiB, ограничение Chromium на сообщение от host. Ответ Service ≤ 512 KiB, поэтому реальный предел не достигается. Если бы достигался — `response_too_large`.
- Невалидный UTF-8 в payload — `malformed_json`.

## Происхождение вызова

Chromium на Windows запускает host так:

```text
SelectiveVpnRouter.NativeHost.exe chrome-extension://<id>/ --parent-window=<hwnd>
```

Две независимые проверки:

1. `allowed_origins` в registry-manifest — ровно `["chrome-extension://lfaekfalhkgmbfdjjlfcalanhijeaien/"]`, без wildcard.
2. Host сам проверяет argv:
   - `argv[0]` должен побайтно совпасть с этим origin;
   - остальные аргументы допустимы только в виде `--parent-window=<digits>`.

При несовпадении или отсутствии origin host ни одной команды не выполняет и к Service не подключается. Stdin не читается, в stdout пишется один ответ `forbidden_origin` с `requestId: null`, выход с кодом 4. В stderr логируется категория (`Missing` / `Mismatch` / `UnexpectedArguments`), но не сам отвергнутый аргумент.

## Запрос

```json
{ "protocolVersion": 1, "requestId": "550e8400-e29b-41d4-a716-446655440000", "command": "getStateManifest" }
```

```json
{
  "protocolVersion": 1,
  "requestId": "550e8400-e29b-41d4-a716-446655440001",
  "command": "getStatePage",
  "stateGeneration": "75f5c435-6ac5-45a5-876b-042a6376635e",
  "revision": 0,
  "startIndex": 0
}
```

- Поля строго по команде:
  - `ping` и `getStateManifest` — ровно `{protocolVersion, requestId, command}`;
  - `getStatePage` — плюс ровно `stateGeneration`, `revision`, `startIndex`.

  Лишние или повторяющиеся поля дают `invalid_request`. Неизвестное поле верхнего уровня отклоняется до чтения `requestId`, поэтому ответ идёт с `requestId: null`.
- `protocolVersion` — JSON-целое. Не `1` — `unsupported_protocol_version`. Не число или отсутствует — `invalid_request`.
- `requestId` — строка `1..128` символов из `[A-Za-z0-9._:-]`. Иначе — `invalid_request` с `requestId: null`. Host передаёт его в Service как correlation id.
- `command` — строка. Неизвестная (в том числе прежний `getState`) — `unknown_command`. Имя команды в ответ и в лог не попадает.
- `stateGeneration` — UUID в нижнем регистре.
- `revision` — целое `0..2^53-1`.
- `startIndex` — целое `0..10000`.

## Успешный ответ

```json
{ "protocolVersion": 1, "requestId": "<как в запросе>", "ok": true, "result": { } }
```

## Ошибка

```json
{
  "protocolVersion": 1,
  "requestId": "<как в запросе или null>",
  "ok": false,
  "error": { "code": "service_unavailable", "message": "VPN Route Service is unavailable." }
}
```

`message` — фиксированный текст на код. В нём нет stack trace, типов исключений, путей и фрагментов входа.

`requestId: null` бывает, только если host не смог прочитать `requestId`: битый JSON, невалидный конверт, слишком большой кадр, `forbidden_origin`.

| code | Когда |
|---|---|
| `invalid_message` | пустой кадр (длина 0) |
| `message_too_large` | длина > 64 KiB |
| `malformed_json` | не UTF-8 или не JSON |
| `invalid_request` | конверт или параметры не по схеме |
| `unsupported_protocol_version` | `protocolVersion` ≠ 1 |
| `unknown_command` | команда не `ping` / `getStateManifest` / `getStatePage` |
| `forbidden_origin` | проверка argv не прошла |
| `service_unavailable` | pipe Service не открылся за 1 s, или test pipe override отвергнут |
| `service_untrusted` | владелец pipe не SYSTEM, не Administrators и не текущий пользователь |
| `service_timeout` | Service не ответил за 3 s |
| `service_error` | Service вернул код вне allowlist, или ошибка клиента (тип исключения — только в stderr) |
| `invalid_service_response` | кадр или JSON Service битый, `id` не совпадает, result не прошёл проверку host |
| `browser_state_unavailable` | Service работает, но state не загружен (повреждён, ошибка чтения) |
| `snapshot_changed` | identity страницы не совпадает с текущим state Service |
| `invalid_cursor` | `startIndex` за пределами `ruleCount` |
| `response_too_large` | ответ > 1 MiB |
| `internal_error` | зарезервирован |

Из Service host пересылает только `browser_state_unavailable`, `snapshot_changed` и `invalid_cursor`. Любой другой код Service превращается в `service_error`.

Обрезанный заголовок или payload: ответа нет, выход с кодом 3. Чистый EOF: выход 0.

## Команды

Host — тупой bridge. Каждая команда отображается ровно на один фиксированный метод Service. Generic relay `{command, args}` нет, snapshot host не собирает и не кэширует, revision/generation не создаёт.

| Native Messaging | Service IPC |
|---|---|
| `ping` | — (к Service не обращается) |
| `getStateManifest` | `getManifest` |
| `getStatePage` | `getPage {stateGeneration, revision, startIndex}` |

### `ping`

```json
{ "command": "pong", "host": "SelectiveVpnRouter.NativeHost", "protocolVersion": 1, "hostVersion": "0.5.0" }
```

### `getStateManifest`

`result` — manifest Service как есть:

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

Host проверяет форму, как defense in depth: ровно эти поля, `browserProxy` согласован (Ready ↔ loopback endpoint, Unavailable ↔ `null`). Байты result передаются без пересериализации.

### `getStatePage`

`result` — страница Service как есть:

```json
{ "stateGeneration": "…", "revision": 0, "startIndex": 0, "nextIndex": null, "rules": [ … ] }
```

Host проверяет:

- identity совпадает с запросом;
- `startIndex` повторён;
- `rules` — непустой массив;
- `nextIndex` согласован с `startIndex + rules.length`.

Правила host не валидирует: это делает extension на собранном state.

## Проверки на стороне extension

`createNativeStateProvider().getSnapshot()`:

1. `getStateManifest`, затем `getStatePage` от `startIndex = 0` по `nextIndex`, все с identity из manifest.
2. Каждое сообщение — отдельный `sendNativeMessage`, таймаут 5 s. Общий deadline snapshot — 60 s.
3. Конверт:
   - ровно `{protocolVersion, requestId, ok, result}` или `{protocolVersion, requestId, ok, error}`;
   - `protocolVersion === 1`;
   - `requestId` совпадает с отправленным; `null` допускается только при `ok: false`;
   - `error` ровно `{code, message}`.
4. Manifest — ровно 7 полей:
   - generation — UUID;
   - `ruleCount ≤ 10000`;
   - `0 < pageBudgetBytes ≤ 512 KiB`;
   - `browserProxy` через `validateProxyEndpoint` (Phase 2).
5. Каждая страница — ровно 5 полей:
   - identity и `startIndex` совпадают;
   - правил ≥ 1, суммарно не больше `ruleCount`;
   - `nextIndex` ровно `null` или следующий индекс;
   - размер ≤ 528 KiB;
   - страниц ≤ 160, всего ≤ 96 MiB.
6. `snapshot_changed` на странице — новая попытка с manifest. Попыток максимум 2, затем `snapshot_unstable`.
7. Собранный state проходит `validateBrowserRoutingState` (Phase 1).
8. Только после этого возвращается замороженный snapshot:

   ```text
   BrowserRoutingSnapshot { identity: {stateGeneration, revision}, state, browserProxy }
   ```

   Частичный snapshot не возвращается никогда.

Результат несёт статусы для UI:

- `transport`: `AVAILABLE` / `ERROR`;
- `service`: `AVAILABLE` / `UNAVAILABLE` / `UNKNOWN`;
- `state`: `AVAILABLE` / `UNAVAILABLE` / `INVALID` / `UNKNOWN`;
- `browserProxy`: `READY` / `UNAVAILABLE` / `UNKNOWN`;
- `stats`: попытки, сообщения, страницы, байты.

## Решение: `sendNativeMessage`, а не `connectNative`

- Модель запрос–ответ. Snapshot читается редко: install, startup, кнопка.
- Нет долгоживущего процесса, reconnect и состояния порта, которое надо восстанавливать после засыпания MV3 service worker.
- Host stateless: процесс живёт одно сообщение. Цена — один запуск процесса на страницу. Замер: 10000 типовых правил — 6 сообщений за 0.76 s, 10000 худших — 140 сообщений за 13 s.
- Push-уведомления об изменениях от Service понадобятся позже. Тогда `connectNative` вводится отдельным решением.

## Совместимость

- Phase 5 удалил команду `getState`. Ответ на неё — `unknown_command`. Native-сборка Phase 4 с host Phase 5 не работает. Обе стороны поставляются вместе.
- Новая команда или новое поле — только с явным изменением схемы и тестами на обеих сторонах.
- Несовместимое изменение — `protocolVersion: 2`. Host v1 на него отвечает `unsupported_protocol_version`, клиент v1 отвергает ответ v2.
