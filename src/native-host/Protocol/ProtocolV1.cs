namespace VpnRoute.NativeHost.Protocol;

internal static class ProtocolV1
{
    public const int Version = 1;
    public const string HostName = "SelectiveVpnRouter.NativeHost";
    public const string NativeMessagingName = "com.vpnroute.browser";

    public const int MaxRequestBytes = 64 * 1024;

    // Chromium rejects messages from a native host larger than 1 MB.
    public const int MaxResponseBytes = 1024 * 1024;

    public const int MaxRequestIdLength = 128;
    public const int MaxRules = 10_000;
    public const long MaxRevision = 9_007_199_254_740_991;

    public static class Commands
    {
        public const string Ping = "ping";
        public const string GetStateManifest = "getStateManifest";
        public const string GetStatePage = "getStatePage";
        public const string UpsertRule = "upsertRule";
        public const string DeleteRule = "deleteRule";
        public const string ResetRules = "resetRules";
    }

    public static class Errors
    {
        public const string InvalidMessage = "invalid_message";
        public const string MessageTooLarge = "message_too_large";
        public const string MalformedJson = "malformed_json";
        public const string InvalidRequest = "invalid_request";
        public const string UnsupportedProtocolVersion = "unsupported_protocol_version";
        public const string UnknownCommand = "unknown_command";
        public const string ForbiddenOrigin = "forbidden_origin";
        public const string ServiceUnavailable = "service_unavailable";
        public const string ServiceUntrusted = "service_untrusted";
        public const string ServiceTimeout = "service_timeout";
        public const string ServiceError = "service_error";
        public const string InvalidServiceResponse = "invalid_service_response";
        public const string BrowserStateUnavailable = "browser_state_unavailable";
        public const string SnapshotChanged = "snapshot_changed";
        public const string InvalidCursor = "invalid_cursor";
        public const string ResponseTooLarge = "response_too_large";
        public const string InternalError = "internal_error";
    }
}
