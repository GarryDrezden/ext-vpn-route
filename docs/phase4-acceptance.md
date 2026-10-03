# Phase 4 acceptance — необязательная проверка в Yandex Browser

**Не блокирует Phase 4.** Всё обязательное проверено автоматически (`docs/phase4-native-state-transport.md`). Эта проверка подтверждает только одно: Yandex запускает production host `com.vpnroute.browser` для production extension, host отвечает, и popup показывает это честно.

VPN Route Service в Phase 4 не подключён. Ожидаемый `getState` — `service_unavailable`. Значит, PAC Native build не применит.

```text
cd "E:\Работа\OSPanel\domains\ext-vpn-route"
```

## 0. Подготовка

1. Phase 0 Spike на `browser://extensions` выключен и не оставляет active PAC (см. `docs/phase3-acceptance.md`, раздел 0).
2. Собрать host и native extension:

   ```text
   npm run build:native-host
   npm run build:extension:native
   ```

3. Зарегистрировать host (HKCU, без UAC):

   ```text
   powershell -ExecutionPolicy Bypass -File scripts\native-host\register.ps1
   powershell -ExecutionPolicy Bypass -File scripts\native-host\status.ps1
   ```

   Ожидается `STATUS: REGISTERED (Chrome)`.

4. На карточке «VPN Route» (`lfaekfalhkgmbfdjjlfcalanhijeaien`) нажать «Обновить». Каталог тот же — `dist\extension`.

## A. Транспорт до host

Открыть popup → «Refresh state & apply».

PASS, если:

| Поле | Значение |
|---|---|
| State source | `Native` |
| Native host | `com.vpnroute.browser` |
| Transport | `AVAILABLE` |
| Protocol | `1` |
| Service | `UNAVAILABLE` |
| Last state fetch | `ERROR (service_unavailable)` |
| Last transport error | `none` |

Поле «Routing protection»:

- `NOT_PROTECTED`, если до этого PAC не применялся или был сделан Clear;
- `LAST_KNOWN_GOOD`, если остался PAC из Fixture-сборки Phase 3.

Оба варианта корректны: Native build не очищает чужой или прошлый PAC и не подставляет fixture.

## B. Host не зарегистрирован

```text
powershell -ExecutionPolicy Bypass -File scripts\native-host\unregister.ps1
```

В popup снова «Refresh state & apply».

PASS: Transport `ERROR`, Last transport error `host_not_found: Specified native messaging host not found.`, Service `UNKNOWN`, PAC не изменился.

## Завершение

1. `scripts\native-host\status.ps1` → `STATUS: NOT REGISTERED`.
2. Вернуть Fixture-сборку: `npm run build:extension` и «Обновить» у расширения.

## Что прислать

A и B: PASS/FAIL и значения полей.
