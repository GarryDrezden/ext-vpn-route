# Phase 3 acceptance — Yandex Browser

Только Yandex Browser. Chrome и Edge не нужны.

## Результат: FULL PASS

Проверено вручную в Yandex Browser на сборке `5aed8e5`.

| Шаг | Итог | Наблюдение |
|---|---|---|
| A. Normal fixture | PASS | ID `lfaekfalhkgmbfdjjlfcalanhijeaien`; Proxy API `AVAILABLE`; `controlled_by_this_extension`; fixture `normal`, schemaVersion 1, revision 3001, defaultRoute Direct, 3 of 3; `COMPILED` 3001, 4425 bytes, `127.0.0.1:17891`; `APPLIED` 3001, `CURRENT`, `pac_script`, mandatory `true`, Read-back `data_match`, Last error `none` |
| B. DIRECT | PASS | `example.com` открылся, logger выключен |
| C. VPN fail-closed | PASS | YouTube не открылся, logger выключен |
| D. SOCKS5 | PASS | `SOCKS5 CONNECT ATYP=DOMAIN destination=www.youtube.com port=443`, также `accounts.youtube.com`; logger штатно отвечает general SOCKS server failure |
| E. Clear / Reapply | PASS | см. нюанс ниже; после Reapply: `APPLIED` 3001, `CURRENT`, `pac_script`, mandatory `true`, `data_match`, Last error `none` |
| F. Large PAC | PASS | `large`, revision 3999, 10000 of 10000, 382165 bytes (~373.2 KiB); `APPLIED` 3999, `CURRENT`, mandatory `true`, `data_match`, Last error `none`. После `npm run build:extension` + «Обновить»: `normal` 3001 `APPLIED` `CURRENT` `data_match` |

Выводы:

- Yandex возвращает inline `pacScript.data` в `proxy.settings.get()`: read-back — `data_match`, в том числе для PAC 382 KB.
- Inline PAC ~373 KiB принимается и применяется.
- `Last proxy error: net::ERR_PROXY_CONNECTION_FAILED` в popup — исторический след шагов C/D, где logger выключен или специально отвечает ошибкой. Это не сбой.

Нюанс шага E (окружение, не дефект). Phase 0 spike оставался включённым. После production Clear эффективным стал его старый PAC: raw `get` показал Phase 0 PAC, `www.youtube.com` → `SOCKS5 127.0.0.1:17891`. После выключения spike и очистки его PAC raw API показал `levelOfControl: controllable_by_this_extension`, `value.mode: direct`. Значит, production Clear работает правильно: он снимает только настройку своего расширения, и Chromium возвращает следующую по приоритету.

Cursor уже собрал normal-сборку в `dist\extension` и прогнал автоматические тесты. Повторять сборку не нужно.

```text
cd "E:\Работа\OSPanel\domains\ext-vpn-route"
```

## 0. Подготовка

1. Открыть `browser://extensions`.
2. Phase 0 spike «VPN Route — Phase 0 Spike» **выключить** переключателем, удалять не нужно. Оба расширения управляют прокси: если spike включён, production покажет `CONFLICT`.

   **ВАЖНО:** Phase 0 Spike перед тестом production extension должен быть выключен И не должен оставлять active PAC. Иначе после production Clear эффективным станет PAC spike, и шаг E покажет чужой PAC вместо `direct`.
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
