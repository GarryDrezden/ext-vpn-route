# Phase 5 acceptance — Yandex Browser

**Статус: FULL PASS** (автоматические проверки + ручная приёмка в Yandex Browser, март 2026).

Подтверждена цепочка:

```text
Yandex extension (Native build)
  → Native Messaging → com.vpnroute.browser
  → SelectiveVpnRouter.NativeHost.exe
  → \\.\pipe\SelectiveVpnRouter.BrowserRouting
  → VPN Route Service (реальная установленная служба)
  → persisted BrowserRoutingState
```

Explicit browser proxy в Service нет. Ожидаемый итог: state получен целиком, PAC **не** применяется (`browser_proxy_unavailable`).

## Фактический результат (PASS)

### Live Service smoke (до браузера)

```text
node scripts\check-live-service.js
```

| Поле | Значение |
|---|---|
| transport | AVAILABLE |
| service | AVAILABLE |
| state | AVAILABLE |
| browserProxy | UNAVAILABLE |
| stateGeneration | `75f5c435-6ac5-45a5-876b-042a6376635e` |
| revision | 0 |
| ruleCount | 0 |
| defaultRoute | Direct |
| pages | 0 |
| error | null |

### Подготовка

```text
powershell -ExecutionPolicy Bypass -File scripts\phase5-acceptance.ps1
```

PASS: publish host, Native extension, HKCU register, `status.ps1`, live check — как выше.

### Yandex popup (`Refresh state & apply`)

| Поле | Факт |
|---|---|
| Extension ID | `lfaekfalhkgmbfdjjlfcalanhijeaien` |
| State source | Native |
| Transport / Service / Browser state | AVAILABLE |
| Browser proxy | UNAVAILABLE |
| Fetched snapshot | revision **0** |
| State generation | `75f5c435-6ac5-45a5-876b-042a6376635e` |
| Applied snapshot | none |
| Last decision | `browser_proxy_unavailable: state 75f5c435/0 not applied` |
| Routing protection | **LAST_KNOWN_GOOD** |

При этом **старый Phase 3 PAC** (revision 3001, `127.0.0.1:17891`, APPLIED CURRENT) **остался** — ожидаемый fail-safe: Service state доступен, production proxy UNAVAILABLE, новый snapshot не применяется, LKG не очищается.

### Cleanup (PASS)

```text
powershell -ExecutionPolicy Bypass -File scripts\phase5-acceptance.ps1 -Finish
```

- production host **UNREGISTERED** (Chrome/Chromium keys absent, manifest removed);
- `dist\extension` — Fixture (revision 3001, 3 rules, PAC 4425 B);
- spike host keys: none.

## UX follow-up (не блокер Phase 5)

В Native mode нижняя секция «State» может показывать данные **last-known-good** Phase 3 fixture (revision 3001, endpoint 17891), пока сверху `Fetched revision = 0` от Service. Это не функциональный дефект. Позже: переименовать секцию (например «Applied / Last-known-good») или явно маркировать source.

## Повторная проверка

Инструкция для нового прогона: разделы 0–C ниже. После теста — `-Finish`.

```text
cd "E:\Работа\OSPanel\domains\ext-vpn-route"
```

### 0. Подготовка

1. Phase 0 Spike выключен, без active PAC (`docs/phase3-acceptance.md`, §0).
2. `scripts\phase5-acceptance.ps1` → REGISTERED + live JSON AVAILABLE.
3. Reload расширения из `dist\extension` (Native build).

### A–C

Критерии PASS — как в таблице выше; host unregister → `host_not_found`, PAC без изменений.
