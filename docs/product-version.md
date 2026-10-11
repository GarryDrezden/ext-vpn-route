# VPN Route product versioning

## Current identity

**VPN Route 1.0.0** (stable)

- **Git tag (when released):** `v1.0.0`
- Browser Routing **API v1** and Native Messaging **protocol v1** are independent of product SemVer.

## Single sources of truth

| Repo | Canonical file | Derived examples |
|------|----------------|------------------|
| **ext-vpn-route** | `version/product-version.json` | `package.json` → `1.0.0`; Chromium `manifest.version` → `1.0.0.0`; `manifest.version_name` → `1.0.0` |
| **vpn-gateway** | `Directory.Build.props` (`VpnRouteProductVersion`, `VpnRouteReleaseChannel`, `VpnRouteReleaseRevision`) | Assembly/file `1.0.0.0`; display `1.0.0` via `ProductVersionInfo` |

Keep both repos aligned on the same `productVersion`, channel, and revision when bumping releases.

## Stable mapping (1.0.0)

| Field | Value |
|-------|--------|
| `productVersion` | `1.0.0` |
| `releaseChannel` | `stable` |
| `releaseRevision` | `0` |
| Public / display | `1.0.0` |
| Assembly / file / numeric / `manifest.version` | `1.0.0.0` |
| `manifest.version_name` | `1.0.0` |
| npm `package.json` | `1.0.0` |

Build scripts (`scripts/product-version.js`, `scripts/build-extension.js`, `scripts/build-native-host.js`) read the extension SSOT; gateway MSBuild reads `Directory.Build.props`.

## Historical note — final RC (RC19)

Before the first stable **1.0.0** identity on `main`, the last accepted release candidate was **RC19**:

- Display: `1.0.0 RC19`
- Numeric / file / manifest.version: `1.0.0.19`
- npm: `1.0.0-rc.19`

That was **not** public SemVer `1.0.19`; revision tracked the RC iteration under product target `1.0.0`.
