# Phase 0A acceptance

Проверка только для spike. Первым идёт Yandex Browser. PASS по исходному коду не ставится.

## Результат

Phase 0A — **PASS** по ручному прогону в Yandex Browser и Chrome.

| Проверка | Yandex Browser | Chrome |
|---|---|---|
| Proxy API | AVAILABLE | AVAILABLE |
| levelOfControl | `controlled_by_this_extension` | `controlled_by_this_extension` |
| PAC status | APPLIED | APPLIED |
| `www.youtube.com` → SOCKS5 `127.0.0.1:17891` | PASS | PASS |
| Hostname в SOCKS5 | `ATYP=DOMAIN destination=www.youtube.com port=443` | `ATYP=DOMAIN` |
| Logger остановлен → YouTube не открывается | PASS, fail-closed | PASS, fail-closed |
| `example.com` при остановленном logger | DIRECT, открывается | DIRECT, открывается |
| QUIC / NetLog | PASS, разбор ниже | не проводился |

Edge намеренно не тестировался: для текущего acceptance Yandex и Chrome достаточно.

### QUIC и IPv6 в NetLog Yandex

Разобран только NetLog Yandex. По Chrome такого разбора не было.

- Браузер видел Alt-Svc с QUIC для `www.youtube.com` и создавал альтернативный `HTTP_STREAM_JOB` с `using_quic=true`.
- Реальная `QUIC_SESSION` к YouTube не создавалась. Origin-соединение ушло через SOCKS5 на localhost.
- В логе есть UDP connect к `[2001:4860:4860::8888]:443`. Это `HOST_RESOLVER_MANAGER_IPV6_REACHABILITY_CHECK`: проверка доступности IPv6, завершилась `ERR_ADDRESS_UNREACHABLE` (-109), `ipv6_available=false`. Обходом через origin QUIC это не является.

Глобальное отключение QUIC для этого результата не понадобилось. Вывод относится только к PAC → SOCKS5 для одного exact host в этой версии Yandex. Поведение с несколькими VPN-хостами и при живом upstream-соединении не проверялось.

NetLog-файлы в историю репозитория не попадают: `*net-export*.json` в `.gitignore`.

## Процедура

Нужен обычный доступ в интернет для `https://example.com/`. Внешний VPN для этого spike отключать не нужно: `www.youtube.com` и так не должен открыться.

## A. START LOGGER

Из корня репозитория:

```text
dotnet run --project spike/socks5-logger/Socks5Logger.csproj
```

Ожидаемые строки:

```text
SOCKS5 logger listening on 127.0.0.1:17891
diagnostic sink only: no DNS, no forwarding
```

Окно не закрывать. Остановка позже — Ctrl+C.

## B. LOAD EXTENSION — YANDEX

1. Открыть Yandex Browser.
2. Перейти на `browser://extensions`. Если страница не открывается: меню → Дополнения → управление расширениями.
3. Включить режим разработчика.
4. Нажать «Загрузить распакованное расширение».
5. Выбрать папку `E:\Работа\OSPanel\domains\ext-vpn-route\spike\extension`.
6. Открыть popup spike-расширения.

Chrome, после Yandex: `chrome://extensions` → режим разработчика → «Загрузить распакованное расширение» → та же папка.

Edge в текущий acceptance не входит.

С Phase 0B имя расширения — «VPN Route — Phase 0 Spike», а ID закреплён ключом в manifest. PAC-тест не изменился.

Окно должно быть обычным, не инкогнито.

## C. TEST 1 — PROXY API

В popup:

```text
Proxy API: AVAILABLE
Level of control: controllable_by_this_extension
  или controlled_by_this_extension
PAC status: APPLIED
Test host: www.youtube.com
SOCKS endpoint: 127.0.0.1:17891
Last operation: PAC applied
```

Если level of control другой (`controlled_by_other_extensions`, `not_controllable` или иное фактическое значение) и PAC status не `APPLIED` — это честный результат, не ошибка spike. Записать строку level of control как есть. Успешным применение не считается.

`Reapply PAC` повторяет попытку. Service worker: страница расширений → service worker / «Просмотреть представления» → консоль. Там должны быть строки `[VPN Route Phase0]`.

## D. TEST 2 — SOCKS DOMAIN

Logger запущен, PAC applied.

Открыть новую вкладку:

```text
https://www.youtube.com/
```

Страница не загрузится. Logger специально не соединяется с YouTube.

PASS — в логе есть блок такого вида:

```text
[connection #1]
client: 127.0.0.1:<ephemeral>
version: SOCKS5
command: CONNECT
atyp: DOMAIN
destination: www.youtube.com
port: 443
ATYP=DOMAIN destination=www.youtube.com port=443
```

Номер соединения и client-порт могут быть другими. Повторы того же DOMAIN — нормально.

FAIL/INVESTIGATE — вместо `ATYP=DOMAIN` приходит `ATYP=IPv4` или `ATYP=IPv6`, либо строки про `www.youtube.com` нет вообще. Это не маскировать под PASS.

Другие хосты YouTube (`youtube.com`, `googlevideo.com`) в этот spike не входят и могут идти напрямую.

## E. TEST 3 — FAIL CLOSED

1. В окне logger нажать Ctrl+C и дождаться `listener stopped`.
2. PAC не снимать.
3. Обновить `https://www.youtube.com/` или открыть его заново.

PASS — страница не открывается. Типичная ошибка браузера: proxy connection failed.

FAIL — сайт тихо открылся напрямую.

`https://example.com/` в этом тесте не использовать.

## F. TEST 4 — DIRECT UNAFFECTED

Logger по-прежнему остановлен. PAC всё ещё applied.

Открыть:

```text
https://example.com/
```

PASS — страница открывается, если в этот момент есть обычный интернет.

FAIL — example.com тоже умер из-за остановленного logger.

## G. TEST 5 — QUIC / HTTP3

QUIC глобально не отключать. Автоматического PASS нет.

Проверять, пока PAC applied и logger снова запущен. Если он уже остановлен тестом 3:

```text
dotnet run --project spike/socks5-logger/Socks5Logger.csproj
```

В popup нажать `Reapply PAC` и убедиться, что PAC status = `APPLIED`.

### Yandex Browser

1. Открыть `chrome://net-internals/#quic`. Если не открывается, попробовать `browser://net-internals/#quic`.
2. Если страница показывает сессии: открыть `https://www.youtube.com/`, вернуться на страницу QUIC и скопировать текст про `www.youtube.com`.
3. Если страница говорит, что диагностика перенесена, открыть `chrome://net-export/` или `browser://net-export/`.
4. Галочку включения cookies и credentials не ставить.
5. Start Logging to Disk.
6. Открыть `https://www.youtube.com/`.
7. Stop Logging. Скопировать путь к файлу.
8. В PowerShell, подставив свой путь:

```text
Select-String -Path "C:\path\to\chrome-net-export-log.json" -Pattern "QUIC_SESSION","www.youtube.com","127.0.0.1:17891" | Select-Object -First 50
```

### Google Chrome

Те же шаги через `chrome://net-internals/#quic`, затем при необходимости `chrome://net-export/`.

Вернуть:

- какой URL диагностики открылся;
- строки поиска или текст QUIC-страницы про `www.youtube.com`;
- была ли в logger строка `ATYP=DOMAIN destination=www.youtube.com port=443`.

PASS:

- logger получил DOMAIN `www.youtube.com:443`;
- в диагностике нет QUIC-сессии и нет прямого UDP/443 к `www.youtube.com`.

FAIL:

- есть QUIC-сессия или прямой UDP/443 к `www.youtube.com` при включённом PAC;
- либо страница YouTube открылась, а logger не увидел CONNECT.

Если встроенная страница в Yandex отсутствует, записать, какие URL не открылись. Это тоже результат, не повод ставить Wireshark.

## H. CLEANUP

1. Popup → `Clear extension proxy`.
2. PAC status должен стать `NOT APPLIED`. Level of control — фактическое значение после снятия.
3. На странице расширений удалить или выключить spike-расширение.
4. Если logger ещё запущен — Ctrl+C.
5. Открыть обычный сайт и убедиться, что он больше не зависит от spike.

После cleanup прислать: браузер и версию со страницы `browser://version` / `chrome://version` (первые строки), результат тестов 1–5 и кусок лога logger.
