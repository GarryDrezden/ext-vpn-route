using System.Buffers;
using System.Buffers.Binary;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text.Json;

namespace VpnRoute.NativeHost.Service;

/// <summary>
/// Talks to the VPN Route Service over its local browser routing pipe: one connection per request,
/// one request frame, one response frame. No reconnect loop, no caching, no state.
///
/// The pipe is opened with SecurityIdentification, so the Service can identify but never impersonate
/// the browser user. Before sending anything the client checks the pipe owner: only LocalSystem,
/// Administrators or the current user may own it; a pipe created by any other account is rejected
/// as a possible name squatter.
/// </summary>
internal sealed class BrowserRoutingPipeClient(string? pipeName = ServiceIpcV1.PipeName) : IServiceStateClient
{
    private static readonly JsonDocumentOptions ResponseOptions = new() { MaxDepth = 16 };

    public Task<ServiceReply> GetManifestAsync(string correlationId, CancellationToken cancellationToken) =>
        SendAsync(correlationId, BuildRequest(correlationId, ServiceIpcV1.Methods.GetManifest, null), cancellationToken);

    public Task<ServiceReply> GetPageAsync(string correlationId, SnapshotIdentity identity, int startIndex, CancellationToken cancellationToken) =>
        SendAsync(correlationId, BuildRequest(correlationId, ServiceIpcV1.Methods.GetPage, writer =>
        {
            writer.WriteString("stateGeneration", identity.StateGeneration);
            writer.WriteNumber("revision", identity.Revision);
            writer.WriteNumber("startIndex", startIndex);
        }), cancellationToken);

    private async Task<ServiceReply> SendAsync(string correlationId, byte[] request, CancellationToken cancellationToken)
    {
        if (pipeName is null)
            throw new ServiceUnavailableException();
        using var pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous,
            TokenImpersonationLevel.Identification);
        try
        {
            await pipe.ConnectAsync(ServiceIpcV1.ConnectTimeout, cancellationToken).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is TimeoutException or IOException or UnauthorizedAccessException)
        {
            throw new ServiceUnavailableException();
        }

        if (!IsTrustedOwner(pipe))
            throw new ServiceUntrustedException();

        var header = new byte[4];
        BinaryPrimitives.WriteInt32LittleEndian(header, request.Length);
        await pipe.WriteAsync(header, cancellationToken).ConfigureAwait(false);
        await pipe.WriteAsync(request, cancellationToken).ConfigureAwait(false);
        await pipe.FlushAsync(cancellationToken).ConfigureAwait(false);

        if (!await ReadExactlyAsync(pipe, header, cancellationToken).ConfigureAwait(false))
            throw new InvalidServiceResponseException();
        var length = BinaryPrimitives.ReadInt32LittleEndian(header);
        if (length is <= 0 or > ServiceIpcV1.MaxResponseBytes)
            throw new InvalidServiceResponseException();
        var body = new byte[length];
        if (!await ReadExactlyAsync(pipe, body, cancellationToken).ConfigureAwait(false))
            throw new InvalidServiceResponseException();
        return ParseResponse(body, correlationId);
    }

    private static bool IsTrustedOwner(NamedPipeClientStream pipe)
    {
        try
        {
            var owner = pipe.GetAccessControl().GetOwner(typeof(SecurityIdentifier)) as SecurityIdentifier;
            return IsTrustedOwner(owner, WindowsIdentity.GetCurrent().User);
        }
        catch (Exception ex) when (ex is UnauthorizedAccessException or InvalidOperationException or IOException)
        {
            return false;
        }
    }

    internal static bool IsTrustedOwner(SecurityIdentifier? owner, SecurityIdentifier? currentUser) =>
        owner is not null && (owner.IsWellKnown(WellKnownSidType.LocalSystemSid)
            || owner.IsWellKnown(WellKnownSidType.BuiltinAdministratorsSid)
            || (currentUser is not null && owner.Equals(currentUser)));

    /// <summary>Strict IPC v1 envelope check; returns the raw bytes of <c>result</c> without re-encoding them.</summary>
    internal static ServiceReply ParseResponse(byte[] body, string correlationId)
    {
        try
        {
            using var document = JsonDocument.Parse(body, ResponseOptions);
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
                throw new InvalidServiceResponseException();

            var names = root.EnumerateObject().Select(p => p.Name).ToList();
            if (names.Count != 4 || names.Distinct(StringComparer.Ordinal).Count() != 4)
                throw new InvalidServiceResponseException();
            if (!root.TryGetProperty("version", out var version) || version.ValueKind != JsonValueKind.Number ||
                !version.TryGetInt32(out var v) || v != ServiceIpcV1.Version)
                throw new InvalidServiceResponseException();
            if (!root.TryGetProperty("ok", out var ok) || ok.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
                throw new InvalidServiceResponseException();
            if (!root.TryGetProperty("id", out var id))
                throw new InvalidServiceResponseException();

            if (ok.GetBoolean())
            {
                if (id.ValueKind != JsonValueKind.String || id.GetString() != correlationId)
                    throw new InvalidServiceResponseException();
                if (!root.TryGetProperty("result", out var result) || result.ValueKind != JsonValueKind.Object)
                    throw new InvalidServiceResponseException();
                return ServiceReply.Success(JsonMarshal.GetRawUtf8Value(result).ToArray());
            }

            // A Service that could not read the request answers with id null.
            if (!(id.ValueKind == JsonValueKind.Null || (id.ValueKind == JsonValueKind.String && id.GetString() == correlationId)))
                throw new InvalidServiceResponseException();
            if (!root.TryGetProperty("error", out var error) || error.ValueKind != JsonValueKind.Object ||
                !error.TryGetProperty("code", out var code) || code.ValueKind != JsonValueKind.String ||
                error.EnumerateObject().Count() != 1)
                throw new InvalidServiceResponseException();
            return ServiceReply.Failure(code.GetString()!);
        }
        catch (JsonException)
        {
            throw new InvalidServiceResponseException();
        }
    }

    private static byte[] BuildRequest(string id, string method, Action<Utf8JsonWriter>? writeParams)
    {
        var buffer = new ArrayBufferWriter<byte>(256);
        using (var writer = new Utf8JsonWriter(buffer))
        {
            writer.WriteStartObject();
            writer.WriteNumber("version", ServiceIpcV1.Version);
            writer.WriteString("id", id);
            writer.WriteString("method", method);
            if (writeParams is not null)
            {
                writer.WriteStartObject("params");
                writeParams(writer);
                writer.WriteEndObject();
            }
            writer.WriteEndObject();
        }
        if (buffer.WrittenCount > ServiceIpcV1.MaxRequestBytes)
            throw new InvalidOperationException("Service request is too large.");
        return buffer.WrittenSpan.ToArray();
    }

    private static async Task<bool> ReadExactlyAsync(Stream stream, byte[] buffer, CancellationToken cancellationToken)
    {
        var offset = 0;
        while (offset < buffer.Length)
        {
            var read = await stream.ReadAsync(buffer.AsMemory(offset), cancellationToken).ConfigureAwait(false);
            if (read == 0)
                return false;
            offset += read;
        }
        return true;
    }
}
