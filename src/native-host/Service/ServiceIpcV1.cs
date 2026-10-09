namespace VpnRoute.NativeHost.Service;

/// <summary>
/// Client side of the VPN Route browser routing Service IPC v1 (docs/service-ipc-browser-routing-v1.md).
/// Versioned independently of the Native Messaging protocol.
/// </summary>
internal static class ServiceIpcV1
{
    public const string PipeName = "SelectiveVpnRouter.BrowserRouting";
    public const string EventsPipeName = "SelectiveVpnRouter.BrowserRouting.Events";
    public const int Version = 1;
    public const int EventsVersion = 1;

    public const int MaxRequestBytes = 4 * 1024;
    public const int MaxResponseBytes = 512 * 1024;

    public static readonly TimeSpan ConnectTimeout = TimeSpan.FromSeconds(1);

    /// <summary>
    /// Test seam: lets cross-process tests run a stand-in Service on a private pipe while the real
    /// Service owns <see cref="PipeName"/>. Only names in the test namespace are accepted, the pipe
    /// owner check still applies, and an invalid value disables the Service connection entirely.
    /// </summary>
    public const string TestPipeVariable = "VPN_ROUTE_TEST_SERVICE_PIPE";
    public const string TestEventsPipeVariable = "VPN_ROUTE_TEST_SERVICE_EVENTS_PIPE";

    private const string TestPipePrefix = PipeName + ".Test.";
    private const string TestEventsPipePrefix = EventsPipeName + ".Test.";

    /// <summary>Resolves the pipe to use; null means "misconfigured, do not connect".</summary>
    public static string? ResolvePipeName(string? testOverride)
    {
        if (string.IsNullOrEmpty(testOverride))
            return PipeName;
        if (testOverride.Length != TestPipePrefix.Length + 32 || !testOverride.StartsWith(TestPipePrefix, StringComparison.Ordinal))
            return null;
        foreach (var c in testOverride.AsSpan(TestPipePrefix.Length))
        {
            if (c is not (>= '0' and <= '9' or >= 'a' and <= 'f'))
                return null;
        }
        return testOverride;
    }

    public static string? ResolveEventsPipeName(string? testOverride)
    {
        if (string.IsNullOrEmpty(testOverride))
            return EventsPipeName;
        if (testOverride.Length != TestEventsPipePrefix.Length + 32 ||
            !testOverride.StartsWith(TestEventsPipePrefix, StringComparison.Ordinal))
            return null;
        foreach (var c in testOverride.AsSpan(TestEventsPipePrefix.Length))
        {
            if (c is not (>= '0' and <= '9' or >= 'a' and <= 'f'))
                return null;
        }
        return testOverride;
    }

    public const int MaxEventBytes = 1024;

    public static class Methods
    {
        public const string GetManifest = "getManifest";
        public const string GetPage = "getPage";
        public const string UpsertRule = "upsertRule";
        public const string DeleteRule = "deleteRule";
        public const string ResetRules = "resetRules";
    }

    public static class EventsMethods
    {
        public const string SubscribeEvents = "subscribeEvents";
    }

    public static class EventTypes
    {
        public const string BrowserRoutingChanged = "browserRoutingChanged";
        public const string ServiceAvailable = "serviceAvailable";
    }

    /// <summary>Service error codes forwarded to the extension as-is; any other code becomes service_error.</summary>
    public static readonly IReadOnlySet<string> ForwardedErrors = new HashSet<string>(StringComparer.Ordinal)
    {
        "browser_state_unavailable", "snapshot_changed", "invalid_cursor",
        "invalid_request", "revision_conflict", "validation_failed", "not_found", "persistence_failed"
    };
}
