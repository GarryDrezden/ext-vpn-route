using System.Globalization;
using System.Text.Json;
using System.Text.Unicode;
using VpnRoute.NativeHost.Service;

namespace VpnRoute.NativeHost.Protocol;

internal readonly record struct DispatchResult(byte[] Response, string Command, string Outcome);

/// <summary>Validates a v1 request envelope and runs one of the fixed commands.</summary>
internal sealed class RequestDispatcher(IServiceStateClient serviceClient, TimeSpan serviceTimeout)
{
    public static readonly TimeSpan DefaultServiceTimeout = TimeSpan.FromSeconds(3);

    private static readonly JsonDocumentOptions RequestJsonOptions = new()
    {
        MaxDepth = 8,
        AllowTrailingCommas = false,
        CommentHandling = JsonCommentHandling.Disallow
    };

    private static readonly HashSet<string> EnvelopeFields = new(StringComparer.Ordinal)
    {
        "protocolVersion", "requestId", "command"
    };

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
            if (root.ValueKind != JsonValueKind.Object || !HasOnlyKnownUniqueFields(root))
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

            return commandElement.GetString() switch
            {
                ProtocolV1.Commands.Ping => Ping(requestId),
                ProtocolV1.Commands.GetState => await GetStateAsync(requestId, cancellationToken).ConfigureAwait(false),
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

    private async Task<DispatchResult> GetStateAsync(string requestId, CancellationToken cancellationToken)
    {
        const string command = ProtocolV1.Commands.GetState;
        ServiceStateSnapshot snapshot;
        try
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(serviceTimeout);
            snapshot = await serviceClient.GetStateAsync(timeout.Token)
                .WaitAsync(serviceTimeout, cancellationToken)
                .ConfigureAwait(false);
        }
        catch (ServiceUnavailableException)
        {
            return Fail(requestId, command, ProtocolV1.Errors.ServiceUnavailable);
        }
        catch (Exception ex) when (ex is TimeoutException or OperationCanceledException && !cancellationToken.IsCancellationRequested)
        {
            return Fail(requestId, command, ProtocolV1.Errors.ServiceTimeout);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            return Fail(requestId, command, ProtocolV1.Errors.ServiceError, ex.GetType().Name);
        }

        if (snapshot is null || snapshot.State.ValueKind != JsonValueKind.Object
            || snapshot.ProxyEndpoint is null || !IsLoopbackEndpoint(snapshot.ProxyEndpoint))
            return Fail(requestId, command, ProtocolV1.Errors.InvalidServiceResponse);

        var response = ResponseWriter.Success(requestId, writer =>
        {
            writer.WriteStartObject();
            writer.WritePropertyName("state");
            snapshot.State.WriteTo(writer);
            writer.WriteStartObject("proxyEndpoint");
            writer.WriteString("host", snapshot.ProxyEndpoint.Host);
            writer.WriteNumber("port", snapshot.ProxyEndpoint.Port);
            writer.WriteEndObject();
            writer.WriteEndObject();
        });

        if (response.Length > ProtocolV1.MaxResponseBytes)
            return Fail(requestId, command, ProtocolV1.Errors.ResponseTooLarge);

        return new DispatchResult(response, command, "ok");
    }

    private static DispatchResult Fail(string? requestId, string command, string code, string? detail = null) =>
        new(ResponseWriter.Error(requestId, code), command, detail is null ? code : $"{code} ({detail})");

    private static bool HasOnlyKnownUniqueFields(JsonElement root)
    {
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var property in root.EnumerateObject())
        {
            if (!EnvelopeFields.Contains(property.Name) || !seen.Add(property.Name))
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

    internal static bool IsLoopbackEndpoint(ProxyEndpoint endpoint)
    {
        if (endpoint.Port is < 1 or > 65535 || endpoint.Host is null)
            return false;
        var parts = endpoint.Host.Split('.');
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
