# ext-vpn-route

Браузерная часть [VPN Route](https://github.com/GarryDrezden/Vpn-gateway): выборочная маршрутизация сайтов по доменам в Chromium.

Браузер целиком через VPN не отправляется. Пользователь задаёт маршрут сайта: по умолчанию, через VPN или напрямую.

Пример: Telegram и Cursor идут через VPN, Yandex Browser — напрямую, а внутри браузера YouTube и ChatGPT идут через VPN, Ozon и Госуслуги — напрямую.

## Что делает расширение

- определяет текущий домен;
- даёт выбрать маршрут за пару действий;
- применяет политику прокси через `chrome.proxy` и PAC;
- показывает, какой маршрут сейчас действует;
- получает правила от desktop VPN Route по Native Messaging.

Расширение не поднимает VPN, не меняет системную маршрутизацию и не хранит правила как источник истины.

## Чего здесь нет

Этот репозиторий не содержит Windows-приложение, службу, драйвер, OpenVPN и локальный прокси.

Их репозиторий — [Vpn-gateway](https://github.com/GarryDrezden/Vpn-gateway). Там же живут:

- явный SOCKS5 на loopback;
- DNS для адресов, которые идут через VPN;
- хранение правил;
- Native Messaging Host;
- регистрация host в portable-поставке.

Расширение только говорит с этим host. Host — мост без собственной бизнес-логики.

## Поведение V1

Маршрут задаётся домену, не вкладке. Две вкладки одного сайта используют одно правило.

Браузеры, в порядке приоритета:

1. Yandex Browser
2. Google Chrome
3. Microsoft Edge

Формат расширения — Manifest V3.

Режимы:

- **По умолчанию** — снять более общее правило и вернуть обычный путь браузера. В V1 это напрямую.
- **Через VPN** — только локальный SOCKS5. Если VPN недоступен, запрос обрывается и не уходит в обход.
- **Напрямую** — всегда мимо VPN.

Область правила:

- только этот хост;
- хост и его поддомены.

Более конкретное правило побеждает. `video.google.com` может идти через VPN, пока `google.com` идёт напрямую.

Локальные адреса (`localhost`, `127.0.0.0/8`, `::1` и частные IP-литералы) в VPN-прокси не отправляются. Точный список — в `docs/pac-compiler-v1.md`.

## Как проходит трафик

```text
Chromium
  PAC
    ├─ домен через VPN → SOCKS5 127.0.0.1:<port>
    └─ остальное        → напрямую
         │
         ▼
Native Messaging Host
         │
         ▼
VPN Route Service
  loopback SOCKS5
  DNS на стороне VPN
  соединение через OpenVPN
```

Для домена «через VPN» PAC не подставляет запасной прямой путь.

## Статус

- Phase 0A, browser → PAC → SOCKS5: **PASS** в Yandex Browser и Chrome. `docs/phase0-acceptance.md`.
- Phase 0B, Native Messaging ping/pong: **PASS в Yandex Browser**, Chrome намеренно не тестировался. `docs/phase0b-acceptance.md`.
- Phase 1, доменная модель и matcher: `src/domain/browser-routing/`, контракт `docs/browser-routing-contract-v1.md`.
- Phase 2, PAC compiler: `src/pac/`, описание `docs/pac-compiler-v1.md`. Через `chrome.proxy` пока не применяется.

Временный код feasibility-фазы лежит в `spike/` и в продукт не переносится.

```text
npm test
npm run measure:pac
```

Тесты идут на встроенном `node --test`, без зависимостей. Сгенерированный PAC исполняется в изолированном `node:vm` и сверяется с matcher Phase 1.
