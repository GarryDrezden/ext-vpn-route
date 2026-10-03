# Native Messaging protocol v1

Протокол между production extension (`lfaekfalhkgmbfdjjlfcalanhijeaien`) и production native host `com.vpnroute.browser` (`SelectiveVpnRouter.NativeHost.exe`).

Код host: `src/native-host/`. Код клиента: `src/extension/state/native-state-provider.js`.

## Транспорт

- Chromium Native Messaging, `stdio`.
- Кадр: 4 байта длины little-endian + UTF-8 JSON.
- Клиент вызывает `chrome.runtime.sendNativeMessage`: одно сообщение — один процесс host. `connectNative` не используется.
- stdout host содержит **только** кадры. Диагностика — только stderr (`[native-host] ...`).
- Лимит запроса: 64 KiB. Больше — `message_too_large`, host завершается без чтения payload.
- Лимит ответа: 1 MiB. Это ограничение Chromium на сообщение от host. Больший snapshot — `response_too_large`.
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

При несовпадении или отсутствии origin host ни одной команды не выполняет. Stdin не читается, в stdout пишется один ответ `forbidden_origin` с `requestId: null`, выход с кодом 4. В stderr логируется категория (`Missing` / `Mismatch` / `UnexpectedArguments`), но не сам отвергнутый аргумент.

## Запрос

```json
{ "protocolVersion": 1, "requestId": "550e8400-e29b-41d4-a716-446655440000", "command": "getState" }
```

- Поля ровно эти три. Лишние или повторяющиеся поля дают `invalid_request`.
- `protocolVersion` — JSON-целое. Не `1` — `unsupported_protocol_version`. Не число или отсутствует — `invalid_request`.
- `requestId` — строка `1..128` символов из `[A-Za-z0-9._:-]`. Иначе — `invalid_request` с `requestId: null`.
- `command` — строка. Неизвестная — `unknown_command`; имя команды в ответ и в лог не попадает.

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
| `invalid_request` | конверт не по схеме |
| `unsupported_protocol_version` | `protocolVersion` ≠ 1 |
| `unknown_command` | команда не `ping` / `getState` |
| `forbidden_origin` | проверка argv не прошла |
| `service_unavailable` | Service недоступен |
| `service_timeout` | Service не ответил за 3 s |
| `service_error` | ошибка клиента Service, детали только в stderr (тип исключения) |
| `invalid_service_response` | snapshot от Service не объект или endpoint не loopback |
| `response_too_large` | ответ > 1 MiB |
| `internal_error` | зарезервирован |

Обрезанный заголовок или payload: ответа нет, выход с кодом 3. Чистый EOF: выход 0.

## Команды

### `ping`

Не обращается к Service.

```json
{ "command": "pong", "host": "SelectiveVpnRouter.NativeHost", "protocolVersion": 1, "hostVersion": "0.4.0" }
```

### `getState`

Host вызывает `IServiceStateClient.GetStateAsync` и передаёт ответ без изменений.

```json
{
  "state": { "schemaVersion": 1, "revision": 43, "defaultRoute": "Direct", "rules": [] },
  "proxyEndpoint": { "host": "127.0.0.1", "port": 17891 }
}
```

- `state` — `BrowserRoutingStateV1` (`docs/browser-routing-contract-v1.md`). Host проверяет только, что это JSON-объект. Полную валидацию делает extension.
- `proxyEndpoint` — loopback IPv4 `127.0.0.0/8` без ведущих нулей, порт `1..65535`. Host проверяет это как defense in depth, extension — повторно.
- Метаданные Service и транспорта в `state` не добавляются.
- Host не кэширует ответ: каждый `getState` обращается к Service.
- В Phase 4 production-клиент — `UnavailableServiceStateClient`: всегда `service_unavailable`, без pipe, сокета, файла и реестра.

## Проверки на стороне extension

`createNativeStateProvider` (таймаут 5 s) принимает ответ, только если:

- конверт ровно `{protocolVersion, requestId, ok, result}` или `{protocolVersion, requestId, ok, error}`;
- `protocolVersion === 1`;
- `requestId` совпадает с отправленным; `null` допускается только при `ok: false`;
- `error` ровно `{code, message}`, `code` из `[a-z0-9_]{1,64}`;
- `result` ровно `{state, proxyEndpoint}`, `proxyEndpoint` ровно `{host, port}`;
- `state` проходит `validateBrowserRoutingState` (Phase 1), endpoint — `validateProxyEndpoint` (Phase 2).

Результат — замороженный `BrowserRoutingSnapshot { state, proxyEndpoint }` с canonical state.

## Решение: `sendNativeMessage`, а не `connectNative`

- Модель запрос–ответ, а `getState` — редкая операция: install, startup, кнопка.
- Нет долгоживущего процесса, reconnect и состояния порта, которое надо восстанавливать после засыпания MV3 service worker.
- Host stateless: процесс живёт одно сообщение. Ничего не кэшируется между запросами.
- Push-уведомления об изменениях от Service понадобятся позже. Тогда `connectNative` вводится отдельным решением.

## Совместимость

- Новая команда или новое поле — только с явным изменением схемы и тестами на обеих сторонах.
- Несовместимое изменение — `protocolVersion: 2`. Host v1 на него отвечает `unsupported_protocol_version`, клиент v1 отвергает ответ v2.
