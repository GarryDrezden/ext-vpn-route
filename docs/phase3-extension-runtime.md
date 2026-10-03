# Phase 3 — production extension runtime

Production MV3-расширение: фиксированное BrowserRoutingStateV1 → `compilePacScript` → `chrome.proxy.settings.set` (inline PAC, `mandatory: true`) → read-back → диагностика в popup.

Состояние пока — фиксированный fixture в коде. Service, Native Messaging, хранение правил и их редактор в Phase 3 не входят.

Документ описывает Fixture-сборку. Phase 4 добавил Native-сборку (`nativeMessaging`, состояние от native host), `routing-coordinator.js` и необязательный snapshot в `controller.apply`: см. `docs/phase4-native-state-transport.md`. Для Fixture-сборки всё ниже по-прежнему верно.

## Структура

```text
src/extension/
  manifest.json              пути в нём указаны относительно корня сборки
  background.js              тонкий service worker: события → controller
  runtime/
    proxy-controller.js      state machine применения PAC; chrome API передаются явно
    chrome-adapter.js        promise-обёртки над chrome.proxy/storage, lastError → reject
    config.js                endpoint и ключ storage
  state/smoke-state.js       Phase 3 fixture
  popup/popup.{html,js,css}  диагностика
```

`spike/extension/` остаётся историческим Phase 0 spike и в сборку не входит.

## Сборка

```text
npm run build:extension         # normal fixture, revision 3001
npm run build:extension:large   # dev-only, ~10000 правил, revision 3999
```

Также работает `npm run build:extension -- --fixture=large`. Скрипт `scripts/build-extension.js` без зависимостей. Источник истины — `src/`. Каталог `dist/` — сгенерированный артефакт и лежит в `.gitignore`.

`dist/extension/` повторяет раскладку `src/`, поэтому относительные ES-импорты работают без переписывания:

```text
dist/extension/
  manifest.json
  extension/...                 из src/extension/
  pac/*.js                      из src/pac/
  domain/browser-routing/*.js   из src/domain/browser-routing/
```

Build очищает только свой выходной каталог. Каталог должен лежать внутри `dist/`, иначе build отказывается работать. Затем build копирует файлы, а для `large` генерирует `extension/state/smoke-state.js`.

Затем результат валидируется, при любом нарушении build падает:

- **Файлы:**
  - только `.js`, `.json`, `.html`, `.css`;
  - нет `tests/`, `docs/`, `spike/`, `scripts/`, `.git`, `package.json`.
- **Manifest:**
  - MV3;
  - `permissions` ровно `proxy` и `storage`;
  - нет `host_permissions`, `content_scripts`, `externally_connectable`, `web_accessible_resources` и т. п.;
  - service worker с `"type": "module"`;
  - файлы, на которые ссылается manifest, существуют;
  - ID из `key` равен production ID.
- **Каждый JS:**
  - все импорты относительные, разрешаются и не выходят за корень сборки;
  - `node --check`;
  - запрещены: `require`, `node:`, Node core modules, `process`, `Buffer`, `__dirname`, CommonJS, `import()`, `eval`, `new Function`, `fetch`, XHR, WebSocket, `importScripts`, `setInterval`, `chrome.alarms`, `chrome.tabs`, `chrome.history`, `chrome.webRequest`, native messaging, URL удалённых адресов.
- **HTML:** нет inline-скриптов, inline-обработчиков и внешних ссылок, все `src`/`href` существуют.
- **Fixture:** собранная fixture проходит `validateBrowserRoutingState` и компилируется собранным `pac/`.

## Extension ID

| Расширение | ID |
|---|---|
| Production (`src/extension`) | `lfaekfalhkgmbfdjjlfcalanhijeaien` |
| Phase 0 spike (`spike/extension`) | `onodojebmdbcndjelgfhoiffeojngmbd` |

Production ID закреплён публичным ключом в поле `key` манифеста. Ключ сгенерирован для Phase 3, приватный ключ не сохранялся. Подписанный `.crx` без него не собрать, но unpacked-расширению и будущему `allowed_origins` нужен только ID. Тест сверяет ID с `key` и проверяет, что он не совпадает со spike.

## Fixture

`src/extension/state/smoke-state.js`, `revision 3001`, `defaultRoute Direct`:

| host | matchType | routeMode |
|---|---|---|
| `youtube.com` | DomainAndSubdomains | VPN |
| `googlevideo.com` | DomainAndSubdomains | VPN |
| `example.com` | ExactHost | Direct |

Остальное по `defaultRoute` идёт DIRECT. Fixture импортируется service worker'ом и в `chrome.storage` не хранится.

Endpoint берётся из `runtime/config.js`: `PHASE3_PROXY_ENDPOINT = { proxyHost: "127.0.0.1", proxyPort: 17891 }`. Это Phase 0 SOCKS logger. Controller получает endpoint параметром, поэтому позже его сможет передавать Service.

Large fixture (`scripts/large-fixture.js`):
- генерируется только при сборке, детерминированно: 10000 правил, `revision 3999`;
- первые три правила совпадают с normal fixture;
- остальные — `s<i>.z<i%97>.large.vpnroute.test`.

Runtime ничего не генерирует. PAC normal fixture весит ~4.4 KB, large — ~382 KB.

## State machine (`proxy-controller.js`)

`status` — итог последней операции:

| Status | Значение |
|---|---|
| `IDLE` | Ещё ничего не применялось в этом профиле. |
| `APPLYING` | Записан перед `set()`. |
| `APPLIED` | `set()` прошёл, и read-back показывает этот PAC. |
| `NOT_APPLIED` | После явного Clear: прокси расширения не действует. |
| `ERROR` | Ошибка compile, `set`, `clear` или read-back. Статус держится до следующего успешного apply или clear. |
| `CONFLICT` | `controlled_by_other_extensions`. PAC не записывался. |
| `NOT_CONTROLLABLE` | `not_controllable` (policy). PAC не записывался. |
| `UNAVAILABLE` | Нет `chrome.proxy`. |

`active` — что браузер реально показывает сейчас:

| active.pac | Значение |
|---|---|
| `CURRENT` | Действует PAC текущего compile. |
| `PREVIOUS` | Действует ранее подтверждённый PAC (last known good), а текущий не применён. |
| `UNRECOGNIZED` | Режим `pac_script` от этого расширения, но не тот PAC или не `mandatory`. |
| `NONE` | Прокси этого расширения не действует. |
| `UNKNOWN` | `get()` не удался. |

Все операции идут последовательно: следующая ждёт конца предыдущей.

### Apply

Шаги по порядку, любой сбой завершает apply:

1. Нет `chrome.proxy` → `UNAVAILABLE`.
2. Compile fixture. Ошибка → `ERROR`. `set`/`clear` не вызываются (см. last known good).
3. `settings.get({incognito:false})`, проверка `levelOfControl`:
   - `controllable_by_this_extension` или `controlled_by_this_extension` → дальше;
   - `controlled_by_other_extensions` → `CONFLICT`;
   - `not_controllable` → `NOT_CONTROLLABLE`;
   - другое значение → `ERROR`.

   Повторных попыток нет.
4. Записывается `APPLYING`.
5. `settings.set({ value: { mode: "pac_script", pacScript: { data, mandatory: true } }, scope: "regular" })`. `runtime.lastError` → `ERROR`.
6. Read-back через `settings.get`. `APPLIED` ставится только при всех условиях:
   - `levelOfControl == controlled_by_this_extension`;
   - `mode == pac_script`;
   - `mandatory == true`;
   - если браузер вернул `pacScript.data`, он совпадает со сгенерированным PAC: после замены CRLF→LF и trim, побайтно (`verification: data_match`);
   - если `data` не вернулся — `verification: data_unavailable`. Это не считается ошибкой, но проверка по тексту тогда невозможна.

   Иначе `ERROR` с причиной.
7. Только после этого записывается `lastApplied = { revision, scriptLength, metadata, verification }`.

В Phase 0A Yandex и Chrome возвращали inline `data` в `get()`. Для production compiler это подтверждается в acceptance полем «Read-back».

Applied revision в popup берётся только из `active.revision`. Её даёт классификация read-back: совпадение данных с текущим compile или подтверждённый ранее `lastApplied`. Отдельной mutable-переменной нет.

### Last known good

- Ошибка новой конфигурации (compile, `set`, read-back) **не очищает прокси** и **не ставит DIRECT**.
- Ранее применённый PAC остаётся в браузере. Controller показывает `status ERROR` и `active PREVIOUS` с прежней revision, если браузер всё ещё возвращает этот PAC. Проверка: заголовок с revision и длина совпадают с `lastApplied`; если `data` нет — по `lastApplied`.
- VPN-правило старого PAC продолжает уходить в SOCKS5. Тест это проверяет исполнением PAC.

### Fail-closed при старте

Сценарий: при старте state не компилируется.

1. Уже действует PAC этого расширения → он остаётся (`PREVIOUS`), `ERROR`, текст ошибки: «Last known good PAC revision N stays active».
2. PAC нет → `ERROR`, `active NONE`, текст: «No PAC from this extension is active: routing is NOT protected». Маршрутизация не объявляется защищённой.

Скрытого emergency PAC нет, DIRECT-fallback тоже нет.

### Clear

Только кнопка «Clear extension proxy»:
1. `settings.clear({scope:"regular"})`;
2. read-back: прокси этого расширения не действует → `NOT_APPLIED`, `lastApplied = null`; иначе `ERROR`.

После clear ничего автоматически не применяется. PAC возвращают «Reapply PAC» или следующий `onStartup`/`onInstalled`.

### События

- `runtime.onInstalled` и `runtime.onStartup` → apply.
- Загрузка или пробуждение service worker ничего не применяет.
- Таймеров и polling нет.
- Popup отправляет команды `status` (refresh без записи), `reapply`, `clear`. Принимаются только от своего extension id и не от вкладок; неизвестная команда игнорируется.
- `proxy.onProxyError` → `lastProxyError = { fatal, error, details, at }`. Строки обрезаются до 300 символов. URL и host не записываются, истории нет.

## Storage

В `chrome.storage.local` хранится один ключ `vpnRouteDiagnostics`:
- `diagnosticsVersion`, `status`, `proxyApi`, `levelOfControl`;
- сводка state: revision, счётчики;
- сводка compile;
- `active`, `lastApplied`;
- `lastOperation`, `lastError`, `lastProxyError`.

Правил, host и текста PAC там нет, это проверяет тест. Storage не является источником правил. Диагностика с неизвестной `diagnosticsVersion` отбрасывается.

## Popup

- Шапка: Extension ID, Proxy API, Level of control.
- **State:** fixture, schema version, revision, default route, enabled rules.
- **PAC:** compile status, compiled revision, byte size, endpoint.
- **Applied:**
  - status;
  - applied revision — с пометкой «last known good» или «unconfirmed», если она не текущая;
  - active PAC, mode, mandatory;
  - read-back (`data_match` или `data_unavailable`);
  - last operation, last error, last proxy error.
- Кнопки: Reapply PAC, Clear extension proxy, Refresh status.

## Безопасность

- `permissions`: только `proxy` и `storage`. Нет host permissions, `tabs` и `nativeMessaging`.
- PAC: `mandatory: true`, VPN = `SOCKS5 127.0.0.1:17891` без `; DIRECT`, без DNS-помощников (Phase 2).
- Endpoint — только loopback, это проверяет compiler.
- Чужая proxy-политика не перезаписывается.
- Нет удалённого HTTP, `eval`, генерации кода и логирования посещений.

## Ограничения

- Состояние — фиксированный fixture. Service и Native Messaging не подключены.
- `scope: "regular"`, инкогнито не настраивается.
- Поведение `get()` в Yandex (возвращает ли `data`) и приём ~382 KB inline PAC подтверждаются только ручной проверкой.
- Если Chromium отклонит PAC при исполнении (`onProxyError` с fatal), статус останется `APPLIED`, а ошибка будет в «Last proxy error».
- `lastApplied` проверяется по revision из заголовка и длине, а не по хешу: защита от ошибок, не от подделки.
