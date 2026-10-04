# Phase 5 — интеграция с VPN Route Service

**Статус: FULL PASS** — автоматические тесты, cross-process E2E (10k rules), ручная приёмка в Yandex Browser с production host и реальной службой (`docs/phase5-acceptance.md`).

Цепочка:

```text
Yandex extension (Native build)
  → chrome.runtime.sendNativeMessage("com.vpnroute.browser")
  → SelectiveVpnRouter.NativeHost.exe          (этот репозиторий)
  → \\.\pipe\SelectiveVpnRouter.BrowserRouting  (локальный IPC)
  → VPN Route Service: BrowserRoutingStateStore (Vpn-gateway)
```

Протоколы:

- extension ↔ host: `docs/native-messaging-protocol-v1.md`;
- host ↔ Service: `docs/service-ipc-browser-routing-v1.md`.

## Роли

| Участник | Делает | Не делает |
|---|---|---|
| VPN Route Service | единственный source of truth: хранит state, создаёт `stateGeneration` и `revision`, отдаёт manifest и страницы, сообщает готовность browser proxy | не применяет PAC, не знает о браузере |
| Native host | тупой bridge: 2 фиксированные команды → 2 фиксированных метода Service | не хранит, не кэширует, не собирает snapshot, не создаёт revision/generation, не правит правила, нет generic relay |
| Extension | собирает и валидирует snapshot, решает по lineage и readiness, владеет применением PAC | не хранит правила, не создаёт lineage, без Ready-endpoint не применяет |

## Два независимых вопроса

1. **Доступность state.** Service отвечает, state загружен, snapshot целиком собран и валиден. В popup: «Service», «Browser state».
2. **Готовность explicit browser proxy.** Есть ли loopback endpoint, куда PAC может слать VPN-трафик. В popup: «Browser proxy».

В Phase 5 production Service всегда отвечает `browserProxy: {status: "Unavailable", endpoint: null}`, потому что explicit browser proxy ещё не реализован. Тогда extension:

- показывает Service `AVAILABLE`, Browser state `AVAILABLE`, Browser proxy `UNAVAILABLE`;
- принимает state в lineage, но PAC **не применяет**. Решение — `browser_proxy_unavailable`;
- не очищает прокси и не ставит DIRECT. Действующий PAC остаётся: protection `LAST_KNOWN_GOOD`, без PAC — `NOT_PROTECTED`.

Spike endpoint `127.0.0.1:17891` в Native-сборке не используется. Он остаётся только в Fixture-сборках Phase 3.

## Lineage: generation + revision

Identity snapshot — `{stateGeneration, revision}`. Она идёт рядом со state, а не внутри `BrowserRoutingStateV1`, потому что контракт v1 запрещает лишние поля верхнего уровня.

Coordinator хранит в `vpnRouteStateSource`:

```text
lineage: { currentGeneration, acceptedRevision, appliedIdentity, retiredGenerations[≤16] }
```

Для входящего `{G, R}`:

| Условие | Решение |
|---|---|
| `G` в `retiredGenerations` | `retired_generation`, ничего не применяется |
| `G == currentGeneration`, `R < acceptedRevision` | `stale_snapshot` |
| `G == currentGeneration`, `R ≥ acceptedRevision` | принято |
| `G ≠ currentGeneration` | **новая lineage**: прежний `G` уходит в retired, `lastLineageChange` показывается в UI. Revision нового `G` может быть меньше прежней |

Затем:

- `browserProxy` не Ready → `browser_proxy_unavailable`;
- `appliedIdentity == {G, R}`, PAC `CURRENT`, endpoint тот же → `unchanged`, без `proxy.set`;
- иначе apply. `appliedIdentity` обновляется только после подтверждённого read-back.

### Replay policy

Пример: A41 → A42 → A43, затем Service сделал reset и отдаёт B1. Позже приходит старый ответ A100, например через задержавшийся процесс или откат файла.

- A41 и A42 после A43 — `stale_snapshot`.
- B1 — новая lineage, применяется, A уходит в retired.
- A100 — `retired_generation`, хотя 100 > 1. Старая lineage не может молча снова стать текущей.

Всё это переживает рестарт service worker (`chrome.storage`) и явный Clear. Clear снимает PAC и `appliedIdentity`, но lineage оставляет.

Список retired ограничен 16 поколениями. Replay поколения старше 16 смен поколений будет принят как новая lineage. Это сознательный предел размера диагностики. Generation меняется только при reset или деструктивной миграции, поэтому 16 смен — далеко за реальным сценарием.

Диагностика Phase 4 (`sourceVersion: 1`, `lastAppliedRevision`) не переинтерпретируется: при первом запуске Phase 5 lineage начинается заново.

## Порядок получения snapshot

`NativeStateProvider.getSnapshot()`:

1. manifest → проверка формы, лимитов, readiness;
2. страницы по `nextIndex`, все с identity из manifest;
3. каждая страница проверяется на согласованность (identity, курсор, `nextIndex`, размер);
4. сборка → Phase 1 validation → замороженный snapshot.

| Лимит | Значение |
|---|---|
| правил | 10000 |
| страниц | 160 |
| байт страницы | ≤ 512 KiB + 16 KiB (пересериализация в extension) |
| байт snapshot | 96 MiB |
| попыток при `snapshot_changed` | 2 |
| таймаут сообщения | 5 s |
| deadline snapshot | 60 s |

Любой отказ даёт `ok: false` и ни одного правила. Partial apply невозможен: coordinator получает только целый snapshot.

## Изменения по сравнению с Phase 4

- Host: `UnavailableServiceStateClient` → `BrowserRoutingPipeClient` (named pipe, Identification, проверка владельца). `getState` → `getStateManifest` + `getStatePage`. Версия host `0.5.0`.
- Extension: snapshot `{identity, state, browserProxy}`, постраничный provider, lineage с generation, решение `browser_proxy_unavailable`. В popup появились поля Browser state, Browser proxy, generation, applied snapshot, lineage change и pages. Subtitle — `Phase 5`.
- Service (Vpn-gateway): store, validator, snapshot pager, dispatcher, pipe server, hosted service `BrowserRoutingPipeHost`.
- Общие golden vectors JS/C#: `contracts/browser-routing-v1/golden-vectors.json`.

## Приёмка

Ручной прогон зафиксирован в `docs/phase5-acceptance.md`: generation `75f5c435-…`, revision 0, `browser_proxy_unavailable`, LKG PAC Phase 3 сохранён, cleanup `-Finish` PASS.

## Проверки

Все offline. Ни одна проверка не подключает и не отключает VPN, не перезапускает Service и не пишет в `%ProgramData%`.

```text
npm test                                   # 453: domain, PAC, extension, integration, security
npm run test:native-host                   # 203 xUnit: host, real pipe, real exe
npm run test:e2e                           # 5 cross-process сценариев
npm run build:native-host                  # publish + smoke
node scripts\check-live-service.js         # read-only: host exe → живая служба
```

В Vpn-gateway:

```text
dotnet test SelectiveVpnRouter.sln -c Release
```

Сюда входят `SelectiveVpnRouter.BrowserRouting.Tests`: 143 теста на store, validator, dispatcher, реальный pipe, ACL и source guards.

### Cross-process E2E (`tests/e2e/service-native-host.e2e.js`)

Цепочка:

```text
SelectiveVpnRouter.BrowserRouting.TestHost (production store, dispatcher, pipe server; temp store; private test pipe)
  → named pipe
  → dist\native-host\SelectiveVpnRouter.NativeHost.exe (процесс на сообщение, NM framing)
  → NativeStateProvider / RoutingCoordinator
```

Отчёт с замерами: `dist/e2e/service-native-host-report.json`.

| Сценарий | Результат |
|---|---|
| 10000 типовых правил, proxy Ready | 5 страниц, крупнейший кадр 520 379 B, всего 2.37 MB, 0.76 s; PAC 434 KB совпал с matcher на 20003 хостах; apply → unchanged → bump → apply → reset → новая lineage |
| 10000 правил, proxy Unavailable | state AVAILABLE, `browser_proxy_unavailable`, `proxy.set` не вызван |
| 10000 худших правил | 139 страниц (лимит 160), крупнейший кадр 513 748 B (< 1 MiB), 71.4 MB, 13.3 s; PAC совпал с matcher |
| state меняется во время каждой попытки | `snapshot_unstable` после 2 попыток, last-known-good сохранён |
| Service остановлен | `service_unavailable`, ничего не очищено |

### Проверка на живой службе

`node scripts\check-live-service.js` с production exe против службы под LocalSystem вернул:

- `service AVAILABLE`, `state AVAILABLE`, `browserProxy UNAVAILABLE`;
- revision 0, Direct, 0 правил.

Тем самым подтверждены реальные DACL, проверка владельца (SYSTEM) и `Identification` в связке со службой.

## Ограничения

- Explicit browser proxy в Service нет. В production PAC из Service не применяется никогда: это ожидаемо для Phase 5.
- Правила в Service пока никто не редактирует: нет UI и методов записи. Store поддерживает `Update` и `Reset` для тестов и будущих фаз.
- Native-сборка Phase 4 несовместима с host Phase 5 (`getState` удалён). Обе стороны поставляются вместе.
- Один процесс host на страницу. Для 10000 худших правил это 140 запусков, около 13 s. Типовой state — меньше секунды.
- Retired generations ограничены 16.
- Test seam `VPN_ROUTE_TEST_SERVICE_PIPE` остаётся в production exe: только тестовое пространство имён, проверка владельца сохраняется (`docs/service-ipc-browser-routing-v1.md`).
- Exe не подписан. Manifest указывает абсолютный путь в рабочую копию.
