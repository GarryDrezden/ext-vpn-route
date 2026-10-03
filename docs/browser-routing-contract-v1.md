# Browser Routing contract v1

Граница данных между расширением, Native Host, VPN Route Service и будущими UI-клиентами (TabDock). Здесь описаны только данные и семантика. Транспорт и IPC в Phase 1 не реализованы.

Эталонная реализация: `src/domain/browser-routing/`. Пример состояния: `docs/examples/browser-routing-state-v1.json`. Его разбор проверяется тестом.

## Роли

| Участник | Роль |
|---|---|
| VPN Route Service | Единственный authoritative source of truth: хранит состояние, присваивает `revision` и `id`, валидирует каждое изменение. |
| Extension | UI-клиент и владелец proxy/PAC-политики в Chromium. Получает состояние от Service и строит из него PAC. Правила не хранит как истину; `chrome.storage` допустим только как кэш. |
| Native Host | Тупой мост к Service, доступный только разрешённому extension origin. Состояние не хранит и не интерпретирует. |
| TabDock (позже) | Второй UI-клиент того же контракта. Может показывать маршрут и менять правило через Service. PAC не трогает. |

Все клиенты используют одну семантику matcher. Клиент может считать маршрут локально для UI, но правило на стороне клиента не создаётся и не исправляется.

## BrowserRoutingStateV1

```json
{
  "schemaVersion": 1,
  "revision": 12,
  "defaultRoute": "Direct",
  "rules": []
}
```

| Поле | Тип | Правило |
|---|---|---|
| `schemaVersion` | number | Ровно `1`. Любое другое значение — состояние не принимается. |
| `revision` | integer | От `0` до `2^53-1`. Присваивает Service, растёт при каждом изменении состояния. |
| `defaultRoute` | `VPN` \| `Direct` | Browser default. `Default` здесь запрещён: ему не от чего наследоваться. |
| `rules` | BrowserRoutingRule[] | До 10000 правил. Порядок не влияет на результат. |

Неизвестные поля верхнего уровня отвергаются. Новое поле — это новая `schemaVersion`.

`revision` — JSON-число, а не строка: целого, безопасного для JavaScript (`Number.MAX_SAFE_INTEGER`), хватает для любой реальной истории изменений, и его однозначно читают JavaScript, .NET (`long`) и JSON. Это счётчик, а не время: сравнение `revision` между двумя снимками говорит, какой новее, и не зависит от часов.

## BrowserRoutingRule

```json
{
  "id": "youtube",
  "name": "YouTube",
  "host": "youtube.com",
  "matchType": "DomainAndSubdomains",
  "routeMode": "VPN",
  "enabled": true,
  "source": "User",
  "notes": null
}
```

| Поле | Тип | Правило |
|---|---|---|
| `id` | string | 1–64 символа `A-Z a-z 0-9 _ -`. Уникален среди всех правил, включая выключенные. Присваивает Service. |
| `name` | string | 1–120 символов, не пустой после trim, без управляющих символов. Только для отображения. |
| `host` | string | Canonical host, см. ниже. |
| `matchType` | MatchType | |
| `routeMode` | RouteMode | |
| `enabled` | boolean | Выключенное правило полностью валидируется, но в матчинге и конфликтах не участвует. |
| `source` | RuleSource | |
| `notes` | string \| null | До 1000 символов. Разрешены только tab и переводы строк. Отсутствующее поле читается как `null`. |

Неизвестные поля правила отвергаются. Никаких `fallback`, `proxy`, `DIRECT`-обходов в модели нет.

### MatchType

- `ExactHost` — только этот canonical host.
- `DomainAndSubdomains` — сам host и любой его потомок по границе меток. `example.com` совпадает с `example.com`, `www.example.com`, `a.b.example.com` и не совпадает с `notexample.com`, `example.com.evil.org`.

Regex, wildcard и IP-литералы в v1 не поддерживаются.

### RouteMode

- `VPN` — через VPN.
- `Direct` — напрямую.
- `Default` — для совпавшего host взять `defaultRoute` состояния.

`Default` — явный разрыв наследования. Если правило с `Default` совпало, поиск останавливается, менее конкретные правила не рассматриваются. Пример при `defaultRoute = Direct`: `example.com` DomainAndSubdomains `VPN` и `foo.example.com` ExactHost `Default` дают `foo.example.com` → `Direct`, а `bar.example.com` → `VPN`.

### RuleSource

- `User` — правило создано пользователем через любой UI-клиент.
- `System` — правило создаёт сам VPN Route, например защитное. Сейчас таких правил нет; значение зарезервировано, чтобы UI мог отличать их и не предлагать редактировать.

Источником не бывает конкретный клиент или браузер (`TabDock`, `Yandex`, `Chrome`): клиент не владеет семантикой правила.

## Canonical host

Нормализация одинакова для правил и для проверяемого host:

1. Строка обрезается по краям (`trim`).
2. Отвергается всё, что не является hostname: scheme, userinfo, port, path, query, fragment, `*`, `%`, пробелы и управляющие символы внутри, IPv4- и IPv6-литералы.
3. Снимается одна завершающая точка.
4. Host переводится в ASCII по UTS #46 (WHATWG URL host parser): регистр понижается, Unicode-метки становятся Punycode. `пример.рф` → `xn--e1afmkfd.xn--p1ai`.
5. Результат проверяется: не длиннее 253 символов, метки 1–63 символа из `a-z 0-9 - _`, без дефиса по краям, последняя метка не числовая.

Нормализация идемпотентна. Однометочные host (`intranet`) допустимы. Public Suffix List не применяется.

Service и другие клиенты должны передавать `host` уже в canonical ASCII-форме. Получатель всё равно нормализует и сравнивает canonical-формы, поэтому `Example.COM`, `example.com.` и `example.com` — один host.

## Конфликты

Два **включённых** правила с одинаковыми canonical `host` и `matchType` делают состояние неоднозначным, даже если `routeMode` совпадает. Такое состояние не принимается целиком. Неявного правила «первый выигрывает» или «последний выигрывает» нет.

`example.com` ExactHost и `example.com` DomainAndSubdomains не конфликтуют: у них разная семантика, их разводит приоритет.

## Приоритет

1. Включённое `ExactHost` с тем же canonical host.
2. Включённое `DomainAndSubdomains`, чей host — сам проверяемый host или его предок, с наибольшим числом меток.
3. `defaultRoute`.

Специфичность считается в DNS-метках, а не в длине строки. Результат не зависит от порядка правил.

## MatchResult

Успешный результат:

```json
{
  "ok": true,
  "stateRevision": 12,
  "inputHost": "www.youtube.com",
  "normalizedHost": "www.youtube.com",
  "matched": true,
  "matchedRuleId": "youtube",
  "matchedRuleName": "YouTube",
  "matchedRuleHost": "youtube.com",
  "matchType": "DomainAndSubdomains",
  "ruleRouteMode": "VPN",
  "effectiveRoute": "VPN",
  "reason": "domain_rule"
}
```

`effectiveRoute` — только `VPN` или `Direct`. Без совпадения поля правила равны `null`.

`reason`:

- `exact_rule` — совпало ExactHost с `VPN` или `Direct`;
- `domain_rule` — совпало DomainAndSubdomains с `VPN` или `Direct`;
- `explicit_default` — совпало правило с `Default`, взят `defaultRoute`;
- `browser_default` — совпадений нет, взят `defaultRoute`.

Ошибка:

```json
{
  "ok": false,
  "inputHost": "https://example.com",
  "error": { "code": "invalid_host", "hostError": "has_scheme", "message": "..." },
  "issues": []
}
```

- `invalid_state` — состояние невалидно или неоднозначно, `issues` перечисляет причины;
- `invalid_host` — проверяемый host не является доменным именем, включая IP-литералы.

В ошибке нет `effectiveRoute`. Потребитель не должен подставлять маршрут сам; решение для таких случаев принимает отдельный слой политики (см. ниже).

## Validation issues

```json
{ "code": "conflicting_rules", "path": "/rules", "message": "...", "host": "example.com", "matchType": "ExactHost", "ruleIds": ["a", "b"], "paths": ["/rules/0", "/rules/3"] }
```

`path` — JSON Pointer на проблемное значение. Коды: `invalid_type`, `missing_field`, `unknown_field`, `invalid_id`, `invalid_name`, `invalid_host` (с `hostError`), `unknown_match_type`, `unknown_route_mode`, `invalid_enabled`, `unknown_source`, `invalid_notes`, `duplicate_rule_id`, `conflicting_rules`, `too_many_rules`, `unsupported_schema_version`, `invalid_revision`, `invalid_default_route`.

## Будущие операции

Только концептуально. В Phase 1 не реализованы и через Native Messaging не доступны.

| Операция | Запрос | Ответ |
|---|---|---|
| `getState` | — | BrowserRoutingStateV1 |
| `upsertRule` | rule без `id` или с существующим `id`, `expectedRevision` | новое BrowserRoutingStateV1 или issues |
| `deleteRule` | `id`, `expectedRevision` | новое BrowserRoutingStateV1 или issues |

Service отвергает изменение, если `expectedRevision` не равен текущему `revision`: так два клиента (extension и TabDock) не перетирают друг друга. После любого изменения клиенты получают полный новый снимок, а не дельту.

## Что вне домена

Эти пункты реализует PAC compiler, см. `docs/pac-compiler-v1.md`. Matcher и этот контракт они не меняют.

- Обход localhost, private и link-local адресов — forced-local policy PAC-компилятора. Она стоит выше правил и `defaultRoute`, и в MatchResult её нет.
- Публичный IP-литерал идёт по `defaultRoute`, доменные правила к нему не применяются.
- PAC-компилятор выдаёт для `VPN` только `SOCKS5 127.0.0.1:<port>` без `; DIRECT`. Невалидное состояние не компилируется в PAC вообще.
