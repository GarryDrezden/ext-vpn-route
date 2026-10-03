# Phase 3 acceptance — Yandex Browser

Только Yandex Browser. Chrome и Edge не нужны.

Cursor уже собрал normal-сборку в `dist\extension` и прогнал автоматические тесты. Повторять сборку не нужно.

```text
cd "E:\Работа\OSPanel\domains\ext-vpn-route"
```

## 0. Подготовка

1. Открыть `browser://extensions`.
2. Phase 0 spike «VPN Route — Phase 0 Spike» **выключить** переключателем, удалять не нужно. Оба расширения управляют прокси: если spike включён, production покажет `CONFLICT`.
3. Включить режим разработчика.
4. «Загрузить распакованное расширение» → выбрать папку:

   ```text
   E:\Работа\OSPanel\domains\ext-vpn-route\dist\extension
   ```

5. Убедиться, что у карточки «VPN Route» ID `lfaekfalhkgmbfdjjlfcalanhijeaien`, а у service worker нет красной кнопки «Ошибки».

SOCKS logger пока **не запускать**.

## A. Normal fixture применён

Открыть popup «VPN Route».

PASS, если:

| Поле | Значение |
|---|---|
| Proxy API | `AVAILABLE` |
| Level of control | `controlled_by_this_extension` |
| Fixture | `normal` |
| State: Revision | `3001` |
| Enabled rules | `3 of 3` |
| Compile status | `COMPILED` |
| Compiled revision | `3001` |
| Endpoint | `127.0.0.1:17891` |
| Status | `APPLIED` |
| Applied revision | `3001` |
| Active PAC | `CURRENT` |
| Mode | `pac_script` |
| Mandatory | `true` |
| Last error | `none` |

Поле «Read-back» записать как есть: `data_match` или `data_unavailable`. Это фиксирует, возвращает ли Yandex inline PAC в `get()`.

## B. DIRECT не зависит от прокси

Logger выключен. Открыть:

```text
https://example.com/
```

PASS: страница открылась.

## C. VPN fail-closed

Logger выключен. Открыть:

```text
https://www.youtube.com/
```

PASS: страница **не** открылась, обычно с ошибкой прокси-соединения. В popup поле «Last proxy error» может показать `net::ERR_PROXY_CONNECTION_FAILED`.

FAIL: YouTube открылся напрямую.

## D. Реальный SOCKS5-путь

В отдельном терминале:

```text
cd "E:\Работа\OSPanel\domains\ext-vpn-route"
dotnet run --project spike/socks5-logger/Socks5Logger.csproj
```

Снова открыть `https://www.youtube.com/`. Страница не загрузится: logger диагностический и соединение специально не устанавливает.

PASS — в логе есть такой блок:

```text
version: SOCKS5
command: CONNECT
atyp: DOMAIN
destination: www.youtube.com
port: 443
ATYP=DOMAIN destination=www.youtube.com port=443
```

Могут появиться и другие host YouTube, включая `*.googlevideo.com` из fixture, — это нормально. FAIL: `ATYP=IPv4`/`IPv6` вместо `DOMAIN` или никаких строк про YouTube.

Остановить logger (`Ctrl+C`).

## E. Clear

В popup нажать «Clear extension proxy».

PASS, если в popup:
- Status — `NOT_APPLIED`;
- Active PAC — `NONE`;
- Level of control — `controllable_by_this_extension`;
- Last error — `none`.

Logger выключен. Открыть `https://www.youtube.com/`: теперь поведение такое же, как без расширения, то есть обычная сеть. Ошибки прокси быть не должно.

Нажать «Reapply PAC» → снова `APPLIED`, revision `3001`.

## F. Большой PAC

```text
cd "E:\Работа\OSPanel\domains\ext-vpn-route"
npm run build:extension:large
```

На `browser://extensions` нажать «Обновить» (стрелка) у «VPN Route». Открыть popup.

PASS, если:

| Поле | Значение |
|---|---|
| Fixture | `large` |
| Revision / Compiled revision / Applied revision | `3999` |
| Enabled rules | `10000 of 10000` |
| Byte size | около `382000 bytes` (~373 KiB) |
| Status | `APPLIED` |
| Active PAC | `CURRENT` |
| Last error | `none` |

У service worker не должно быть «Ошибок». «Read-back» записать как есть.

Дополнительно, logger выключен: `https://example.com/` открывается, `https://www.youtube.com/` — нет.

Вернуть normal-сборку:

```text
cd "E:\Работа\OSPanel\domains\ext-vpn-route"
npm run build:extension
```

Затем снова «Обновить» у расширения → popup показывает revision `3001`, `APPLIED`.

## Необязательно: конфликт

Включить Phase 0 spike → в popup «VPN Route» нажать «Reapply PAC». Ожидается `CONFLICT` или `APPLIED` в зависимости от того, какое расширение Yandex считает владельцем: у Chromium побеждает последнее установленное или включённое. Записать результат. Затем выключить spike и нажать «Reapply PAC».

## Что прислать

- Версию Yandex (первая строка `browser://version`).
- A–F: PASS/FAIL. Для A и F — значение «Read-back».
- Блок лога logger из D.
- Любой текст из «Last error» и «Last proxy error», если он был.
