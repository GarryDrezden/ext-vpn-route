namespace VpnRoute.NativeHost.Service;

/// <summary>Optional getManifest heartbeat client identity forwarded to Service IPC params.client.</summary>
internal sealed record ManifestClientInfo(string ExtensionVersion, string NativeHostVersion);
