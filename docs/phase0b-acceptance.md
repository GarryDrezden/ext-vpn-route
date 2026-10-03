# Phase 0B acceptance — Native Messaging

Проверяется только цепочка: расширение → `chrome.runtime.sendNativeMessage` → локальный host → JSON pong → popup. Ни VPN Route Service, ни правил маршрутизации здесь нет.

## Результат

Phase 0B — **PASS в Yandex Browser**. Chrome намеренно не тестировался, PASS для него не заявляется. Edge не входит.

Yandex Browser:

- Host зарегистрирован в HKCU, UAC не понадобился.
- Расширение → `sendNativeMessage` → .NET host → JSON-ответ работает.
- Pong: `ok=true`, `command=pong`, `host=SelectiveVpnRouter.NativeHost.Spike`, `version=0.0.1`.
- Request id сохраняется.
- `AVAILABLE` в popup появляется только при валидном ответе.
- После unregister: `Status=ERROR`, `Response=none`, `Last error="Specified native messaging host not found."`. Закэшированного ложного успеха нет.

Ключ реестра: текущая версия Yandex находит host, когда зарегистрирован **только** `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.vpnroute.phase0b`. Ключ `HKCU\Software\Chromium\NativeMessagingHosts\...` для неё не нужен. Поэтому `register-native-host.ps1` теперь по умолчанию пишет только ключ Chrome, `-Target Chromium` и `-Target All` оставлены для диагностики. Для Portable Bootstrap достаточно одного Chrome-ключа в HKCU, пока другая версия Yandex не покажет иное.

## Процедура

Порядок: Yandex Browser, затем Chrome. Edge не входит.

Host уже собран. Пересобирать его не нужно.

## Что должно совпасть

- Host name: `com.vpnroute.phase0b`
- Extension ID: `onodojebmdbcndjelgfhoiffeojngmbd`

ID закреплён полем `key` в `spike/extension/manifest.json` и должен быть одинаковым в Yandex и Chrome. Если браузер покажет другой ID, ping не пройдёт: `allowed_origins` в host manifest разрешает только этот ID.

## 1. Регистрация

```text
cd "E:\Работа\OSPanel\domains\ext-vpn-route"
.\spike\native-host\register-native-host.ps1
```

Ожидаемо:

```text
Registered: HKCU\Software\Google\Chrome\NativeMessagingHosts\com.vpnroute.phase0b
OK. Reload the unpacked extension, ...
```

Пишется только HKCU, UAC не нужен. Проверить состояние можно так:

```text
.\spike\native-host\status-native-host.ps1
```

Последняя строка: `STATUS: OK (1 registry key(s))`.

## 2. Yandex Browser

1. `browser://extensions`.
2. Удалить старое расширение «VPN Route — Phase 0A Spike». У него был случайный ID unpacked-расширения.
3. «Загрузить распакованное расширение» → `E:\Работа\OSPanel\domains\ext-vpn-route\spike\extension`.
4. В карточке расширения «VPN Route — Phase 0 Spike» записать ID. Ожидается `onodojebmdbcndjelgfhoiffeojngmbd`.
5. Открыть popup → блок «Native Messaging» → `Ping native host`.

PASS:

```text
Status: AVAILABLE
Request id: <uuid>
Response: {"id":"<тот же uuid>","ok":true,"command":"pong","host":"SelectiveVpnRouter.NativeHost.Spike","version":"0.0.1"}
Last error: none
```

FAIL — `Status: ERROR` с текстом в `Last error`. Его прислать как есть. Типичные сообщения Chromium:

- `Specified native messaging host not found.` — браузер не нашёл host по реестру;
- `Access to the specified native messaging host is forbidden.` — ID расширения не совпал с `allowed_origins`;
- `Native host has exited.` / `Error when communicating with the native messaging host.` — процесс host упал или нарушил протокол.

После загрузки расширение снова применяет PAC Phase 0A: `www.youtube.com` → SOCKS5 `127.0.0.1:17891`. Если logger не запущен, YouTube в этом профиле открываться не будет. Ping от этого не зависит. Снять PAC — `Clear extension proxy`.

### 2a. Какой ключ реестра читает Yandex (необязательно, 2 минуты)

Уже проведено для текущей версии: достаточно ключа Chrome. Шаг оставлен для повторной проверки на других версиях Yandex.

В `browser.dll` Yandex `26.10.1.388` есть строки обоих путей: `SOFTWARE\Google\Chrome\NativeMessagingHosts` и `SOFTWARE\Chromium\NativeMessagingHosts`.

```text
.\spike\native-host\unregister-native-host.ps1
.\spike\native-host\register-native-host.ps1 -Target Chrome
```

Popup → `Ping native host`. Записать Status.

```text
.\spike\native-host\unregister-native-host.ps1
.\spike\native-host\register-native-host.ps1 -Target Chromium
```

Popup → `Ping native host`. Записать Status.

Вернуть обычную регистрацию:

```text
.\spike\native-host\register-native-host.ps1
```

Если результат выглядит залипшим, перезапустить браузер и повторить ping.

## 3. Chrome

1. `chrome://extensions` → режим разработчика.
2. Удалить старое расширение Phase 0A, если оно там есть.
3. «Загрузить распакованное расширение» → та же папка.
4. Записать ID. Ожидается `onodojebmdbcndjelgfhoiffeojngmbd`.
5. Popup → `Ping native host`. PASS — то же, что в Yandex.

Регистрация уже сделана в шаге 1, повторять её не нужно.

## 4. Отсутствие ложного успеха

В любом из браузеров:

```text
.\spike\native-host\unregister-native-host.ps1
```

Popup → `Ping native host`. Ожидается `Status: ERROR`, в `Last error` — host not found. `AVAILABLE` здесь — FAIL.

## 5. Cleanup

```text
cd "E:\Работа\OSPanel\domains\ext-vpn-route"
.\spike\native-host\unregister-native-host.ps1
```

В каждом браузере: popup → `Clear extension proxy`, затем удалить или выключить расширение.

## Что прислать

Для Yandex и Chrome:

- версию браузера — первая строка `browser://version` / `chrome://version`;
- ID расширения из карточки;
- блок «Native Messaging» из popup после ping: Status, Response, Last error;
- результат шага 4.

Для Yandex дополнительно — результат 2a, если он проводился: Status при `-Target Chrome` и при `-Target Chromium`.
