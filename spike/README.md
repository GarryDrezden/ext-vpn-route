# Phase 0 spike

Временный код feasibility-фазы. Это не VPN и не продуктовое расширение. Phase 0A — PASS в Yandex и Chrome, Phase 0B — PASS в Yandex. Продуктовый код живёт в `src/` и отсюда не импортирует.

`register-native-host.ps1` по умолчанию пишет только `HKCU\Software\Google\Chrome\NativeMessagingHosts\...`: текущему Yandex этого достаточно по факту, Chrome — по документации (в Chrome Phase 0B не проверялся).

- `extension/` — unpacked MV3: PAC для `www.youtube.com` и ping native host.
- `socks5-logger/` — Phase 0A. Принимает SOCKS5 CONNECT, пишет адрес и закрывает соединение с ошибкой.
- `native-host/` — Phase 0B. Native Messaging host с ping/pong и скриптами регистрации в HKCU.
- `native-host-tests/` — проверка протокола host без браузера.

```text
dotnet run --project spike/socks5-logger/Socks5Logger.csproj
.\spike\native-host\register-native-host.ps1
```

Ручные шаги: [Phase 0A](../docs/phase0-acceptance.md), [Phase 0B](../docs/phase0b-acceptance.md).
