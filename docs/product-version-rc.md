# VPN Route pre-release versioning (RC)

## Current identity

**VPN Route 1.0.0 RC19**

- **Public release target:** first stable **v1.0.0** (not shipped yet).
- **RC19:** 19th accepted/fixed release-candidate iteration before that tag.
- This is **not** a public SemVer release **1.0.19**.

## Single sources of truth

| Repo | Canonical file | Derived examples |
|------|----------------|------------------|
| **ext-vpn-route** | `version/product-version.json` | `package.json` → `1.0.0-rc.19`; Chromium `manifest.version` → `1.0.0.19`; `manifest.version_name` → `1.0.0 RC19` |
| **vpn-gateway** | `Directory.Build.props` (`VpnRouteProductVersion`, `VpnRouteReleaseChannel`, `VpnRouteReleaseRevision`) | Assembly/file `1.0.0.19`; display `1.0.0 RC19` via `ProductVersionInfo` |

Keep both repos aligned on the same `productVersion`, channel, and revision when bumping RC.

## Mapping (extension repo)

| Field | Value (RC19) |
|-------|----------------|
| `productVersion` | `1.0.0` |
| `releaseChannel` | `RC` |
| `releaseRevision` | `19` |
| Display | `1.0.0 RC19` |
| Numeric / file / manifest.version | `1.0.0.19` |
| npm `package.json` | `1.0.0-rc.19` (SemVer prerelease — **not** `manifest.version`) |

Protocol **v1** (`protocolVersion`, `integrationApiVersion`) is unchanged.

## Final release transition (RC → v1.0.0)

When acceptance is complete:

1. Set `releaseChannel` to `stable` (or empty) and `releaseRevision` to `0` in both SSOT files.
2. Set numeric versions to final Chromium-compatible form (e.g. `manifest.version` = `1.0.0.0` or `1.0.0` per validation).
3. Set `manifest.version_name` and product display to **`1.0.0`** (no RC suffix).
4. Set `package.json` to **`1.0.0`**.
5. Build, verify, then tag **`v1.0.0`** — do not tag until this step.

**Before (RC19):** display `1.0.0 RC19`, numeric `1.0.0.19`, npm `1.0.0-rc.19`.

**After (stable):** display `1.0.0`, numeric/file per final policy, npm `1.0.0`.
