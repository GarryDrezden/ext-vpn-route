using System.Globalization;
using System.Text.Json;
using System.Text.Unicode;
using VpnRoute.NativeHost.Service;

namespace VpnRoute.NativeHost.Protocol;

internal readonly record struct DispatchResult(byte[] Response, string Command, string Outcome);

/// <summary>
/// Validates a v1 request envelope and runs one of the fixed commands. Each state command maps to
/// exactly one bounded Service IPC call; the host relays the Service result, it never assembles,
/// caches or edits state.
/// </summary>
internal sealed class RequestDispatcher(IServiceStateClient serviceClient, TimeSpan serviceTimeout)
{
    public static readonly TimeSpan DefaultServiceTimeout = TimeSpan.FromSeconds(3);

    private static readonly JsonDocumentOptions RequestJsonOptions = new()
    {
        MaxDepth = 8,
        AllowTrailingCommas = false,
        CommentHandling = JsonCommentHandling.Disallow
    };

    private static readonly JsonDocumentOptions ResultJsonOptions = new() { MaxDepth = 8 };

    private static readonly HashSet<string> BaseFields = new(StringComparer.Ordinal) { "protocolVersion", "requestId", "command" };
    private static readonly HashSet<string> PageFields = new(StringComparer.Ordinal)
    {
        "protocolVersion", "requestId", "command", "stateGeneration", "revision", "startIndex"
    };

    private static readonly string[] ManifestResultFields =
        ["schemaVersion", "stateGeneration", "revision", "defaultRoute", "ruleCount", "pageBudgetBytes", "browserProxy"];
    private static readonly string[] PageResultFields = ["stateGeneration", "revision", "startIndex", "nextIndex", "rules"];

    public async Task<DispatchResult> DispatchAsync(byte[] payload, CancellationToken cancellationToken)
    {
        if (!Utf8.IsValid(payload))
            return Fail(null, "-", ProtocolV1.Errors.MalformedJson);

        JsonDocument document;
        try
        {
            document = JsonDocument.Parse(payload, RequestJsonOptions);
        }
        catch (JsonException)
        {
            return Fail(null, "-", ProtocolV1.Errors.MalformedJson);
        }

        using (document)
        {
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object || !HasOnlyFields(root, PageFields))
                return Fail(null, "-", ProtocolV1.Errors.InvalidRequest);

            var requestId = ReadRequestId(root);
            if (requestId is null)
                return Fail(null, "-", ProtocolV1.Errors.InvalidRequest);

            if (!root.TryGetProperty("protocolVersion", out var version) || version.ValueKind != JsonValueKind.Number
                || !version.TryGetInt64(out var versionNumber))
                return Fail(requestId, "-", ProtocolV1.Errors.InvalidRequest);
            if (versionNumber != ProtocolV1.Version)
                return Fail(requestId, "-", ProtocolV1.Errors.UnsupportedProtocolVersion);

            if (!root.TryGetProperty("command", out var commandElement) || commandElement.ValueKind != JsonValueKind.String)
                return Fail(requestId, "-", ProtocolV1.Errors.InvalidRequest);

            var command = commandElement.GetString();
            if ((command is ProtocolV1.Commands.Ping or ProtocolV1.Commands.GetStateManifest) && !HasOnlyFields(root, BaseFields))
                return Fail(requestId, command, ProtocolV1.Errors.InvalidRequest);

            return command switch
            {
                ProtocolV1.Commands.Ping => Ping(requestId),
                ProtocolV1.Commands.GetStateManifest => await ManifestAsync(requestId, cancellationToken).ConfigureAwait(false),
                ProtocolV1.Commands.GetStatePage => await PageAsync(requestId, root, cancellationToken).ConfigureAwait(false),
                _ => Fail(requestId, "unknown", ProtocolV1.Errors.UnknownCommand)
            };
        }
    }

    private static DispatchResult Ping(string requestId)
    {
        var response = ResponseWriter.Success(requestId, writer =>
        {
            writer.WriteStartObject();
            writer.WriteString("command", "pong");
            writer.WriteString("host", ProtocolV1.HostName);
            writer.WriteNumber("protocolVersion", ProtocolV1.Version);
            writer.WriteString("hostVersion", HostVersion);
            writer.WriteEndObject();
        });
        return new DispatchResult(response, ProtocolV1.Commands.Ping, "ok");
    }

    private async Task<DispatchResult> ManifestAsync(string requestId, CancellationToken cancellationToken)
    {
        const string command = ProtocolV1.Commands.GetStateManifest;
        var call = await CallAsync(requestId, command, token => serviceClient.GetManifestAsync(requestId, token), cancellationToken)
            .ConfigureAwait(false);
        if (call.Failure is { } failure)
            return failure;
        return IsValidManifest(call.Result!)
            ? Relay(requestId, command, call.Result!)
            : Fail(requestId, command, ProtocolV1.Errors.InvalidServiceResponse);
    }

    private async Task<DispatchResult> PageAsync(string requestId, JsonElement root, CancellationToken cancellationToken)
    {
        const string command = ProtocolV1.Commands.GetStatePage;
        if (!HasExactFields(root, PageFields))
            return Fail(requestId, command, ProtocolV1.Errors.InvalidRequest);
        var generation = root.GetProperty("stateGeneration");
        if (generation.ValueKind != JsonValueKind.String || !IsGeneration(generation.GetString()))
            return Fail(requestId, command, ProtocolV1.Errors.InvalidRequest);
        if (!TryReadInteger(root.GetProperty("revision"), ProtocolV1.MaxRevision, out var revision) ||
            !TryReadInteger(root.GetProperty("startIndex"), ProtocolV1.MaxRules, out var startIndex))
            return Fail(requestId, command, ProtocolV1.Errors.InvalidRequest);

        var identity = new SnapshotIdentity(generation.GetString()!, revision);
        var call = await CallAsync(requestId, command,
            token => serviceClient.GetPageAsync(requestId, identity, (int)startIndex, token), cancellationToken).ConfigureAwait(false);
        if (call.Failure is { } failure)
            return failure;
        return IsValidPage(call.Result!, identity, (int)startIndex)
            ? Relay(requestId, command, call.Result!)
            : Fail(requestId, command, ProtocolV1.Errors.InvalidServiceResponse);
    }

    private readonly record struct ServiceCall(byte[]? Result, DispatchResult? Failure);

    private async Task<ServiceCall> CallAsync(
        string requestId, string command, Func<CancellationToken, Task<ServiceReply>> operation, CancellationToken cancellationToken)
    {
        ServiceReply reply;
        try
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(serviceTimeout);
            reply = await operation(timeout.Token).WaitAsync(serviceTimeout, cancellationToken).ConfigureAwait(false);
        }
        catch (ServiceUnavailableException)
        {
            return new(null, Fail(requestId, command, ProtocolV1.Errors.ServiceUnavailable));
        }
        catch (ServiceUntrustedException)
        {
            return new(null, Fail(requestId, command, ProtocolV1.Errors.ServiceUntrusted));
        }
        catch (InvalidServiceResponseException)
        {
            return new(null, Fail(requestId, command, ProtocolV1.Errors.InvalidServiceResponse));
        }
        catch (Exception ex) when (ex is TimeoutException or OperationCanceledException && !cancellationToken.IsCancellationRequested)
        {
            return new(null, Fail(requestId, command, ProtocolV1.Errors.ServiceTimeout));
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            return new(null, Fail(requestId, command, ProtocolV1.Errors.ServiceError, ex.GetType().Name));
        }

        if (reply is null)
            return new(null, Fail(requestId, command, ProtocolV1.Errors.InvalidServiceResponse));
        if (reply.ErrorCode is { } code)
        {
            var forwarded = ServiceIpcV1.ForwardedErrors.Contains(code) ? code : ProtocolV1.Errors.ServiceError;
            return new(null, Fail(requestId, command, forwarded, forwarded == code ? null : "service code"));
        }
        if (reply.Result is null || reply.Result.Length > ServiceIpcV1.MaxResponseBytes)
            return new(null, Fail(requestId, command, ProtocolV1.Errors.InvalidServiceResponse));
        return new(reply.Result, null);
    }

    private static DispatchResult Relay(string requestId, string command, byte[] result)
    {
        var response = ResponseWriter.SuccessRaw(requestId, result);
        if (response.Length > ProtocolV1.MaxResponseBytes)
            return Fail(requestId, command, ProtocolV1.Errors.ResponseTooLarge);
        return new DispatchResult(response, command, "ok " + response.Length.ToString(CultureInfo.InvariantCulture) + "B");
    }

    /// <summary>Envelope-level checks of a manifest; rule contents are validated by the extension.</summary>
    private static bool IsValidManifest(byte[] result)
    {
        using var document = ParseResult(result);
        if (document is null)
            return false;
        var root = document.RootElement;
        if (!HasExactFields(root, ManifestResultFields))
            return false;
        if (root.GetProperty("stateGeneration") is not { ValueKind: JsonValueKind.String } generation || !IsGeneration(generation.GetString()))
            return false;
        if (!TryReadInteger(root.GetProperty("revision"), ProtocolV1.MaxRevision, out _) ||
            !TryReadInteger(root.GetProperty("ruleCount"), ProtocolV1.MaxRules, out _) ||
            !TryReadInteger(root.GetProperty("pageBudgetBytes"), ServiceIpcV1.MaxResponseBytes, out _))
            return false;

        var proxy = root.GetProperty("browserProxy");
        if (proxy.ValueKind != JsonValueKind.Object || !HasExactFields(proxy, ["status", "endpoint"]))
            return false;
        var status = proxy.GetProperty("status");
        var endpoint = proxy.GetProperty("endpoint");
        return status.ValueKind == JsonValueKind.String && status.GetString() switch
        {
            "Unavailable" => endpoint.ValueKind == JsonValueKind.Null,
            "Ready" => endpoint.ValueKind == JsonValueKind.Object && HasExactFields(endpoint, ["host", "port"]) &&
                endpoint.GetProperty("host").ValueKind == JsonValueKind.String &&
                TryReadInteger(endpoint.GetProperty("port"), 65535, out var port) &&
                IsLoopbackEndpoint(endpoint.GetProperty("host").GetString()!, (int)port),
            _ => false
        };
    }

    private static bool IsValidPage(byte[] result, SnapshotIdentity identity, int startIndex)
    {
        using var document = ParseResult(result);
        if (document is null)
            return false;
        var root = document.RootElement;
        if (!HasExactFields(root, PageResultFields))
            return false;
        if (root.GetProperty("stateGeneration").ValueKind != JsonValueKind.String ||
            root.GetProperty("stateGeneration").GetString() != identity.StateGeneration)
            return false;
        if (!TryReadInteger(root.GetProperty("revision"), ProtocolV1.MaxRevision, out var revision) || revision != identity.Revision)
            return false;
        if (!TryReadInteger(root.GetProperty("startIndex"), ProtocolV1.MaxRules, out var start) || start != startIndex)
            return false;
        var rules = root.GetProperty("rules");
        if (rules.ValueKind != JsonValueKind.Array || rules.GetArrayLength() == 0)
            return false;
        var next = root.GetProperty("nextIndex");
        return next.ValueKind == JsonValueKind.Null ||
            (TryReadInteger(next, ProtocolV1.MaxRules, out var nextIndex) && nextIndex == startIndex + rules.GetArrayLength());
    }

    private static JsonDocument? ParseResult(byte[] result)
    {
        try
        {
            var document = JsonDocument.Parse(result, ResultJsonOptions);
            if (document.RootElement.ValueKind == JsonValueKind.Object)
                return document;
            document.Dispose();
            return null;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static DispatchResult Fail(string? requestId, string command, string code, string? detail = null) =>
        new(ResponseWriter.Error(requestId, code), command, detail is null ? code : $"{code} ({detail})");

    private static bool HasOnlyFields(JsonElement root, HashSet<string> allowed)
    {
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var property in root.EnumerateObject())
        {
            if (!allowed.Contains(property.Name) || !seen.Add(property.Name))
                return false;
        }
        return true;
    }

    private static bool HasExactFields(JsonElement element, IReadOnlyCollection<string> fields)
    {
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var property in element.EnumerateObject())
        {
            if (!fields.Contains(property.Name) || !seen.Add(property.Name))
                return false;
        }
        return seen.Count == fields.Count;
    }

    private static bool TryReadInteger(JsonElement element, long max, out long value)
    {
        value = 0;
        return element.ValueKind == JsonValueKind.Number && element.TryGetInt64(out value) && value >= 0 && value <= max;
    }

    internal static bool IsGeneration(string? value)
    {
        if (value is null || value.Length != 36)
            return false;
        for (var i = 0; i < value.Length; i++)
        {
            var c = value[i];
            var dash = i is 8 or 13 or 18 or 23;
            if (dash ? c != '-' : !(c is >= '0' and <= '9' or >= 'a' and <= 'f'))
                return false;
        }
        return true;
    }

    private static string? ReadRequestId(JsonElement root)
    {
        if (!root.TryGetProperty("requestId", out var element) || element.ValueKind != JsonValueKind.String)
            return null;
        var value = element.GetString();
        if (string.IsNullOrEmpty(value) || value.Length > ProtocolV1.MaxRequestIdLength)
            return null;
        foreach (var c in value)
        {
            var allowed = c is >= 'a' and <= 'z' or >= 'A' and <= 'Z' or >= '0' and <= '9' or '-' or '_' or '.' or ':';
            if (!allowed)
                return null;
        }
        return value;
    }

    internal static bool IsLoopbackEndpoint(string host, int port)
    {
        if (port is < 1 or > 65535)
            return false;
        var parts = host.Split('.');
        if (parts.Length != 4)
            return false;
        foreach (var part in parts)
        {
            if (part.Length is 0 or > 3 || (part.Length > 1 && part[0] == '0'))
                return false;
            foreach (var c in part)
            {
                if (c is < '0' or > '9')
                    return false;
            }
            if (int.Parse(part, NumberStyles.None, CultureInfo.InvariantCulture) > 255)
                return false;
        }
        return parts[0] == "127";
    }

    internal static string HostVersion { get; } =
        typeof(RequestDispatcher).Assembly.GetName().Version?.ToString(3) ?? "0.0.0";
}
