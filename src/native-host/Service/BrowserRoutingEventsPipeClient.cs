using System.Buffers.Binary;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using System.Text.Unicode;
using VpnRoute.NativeHost.Protocol;

namespace VpnRoute.NativeHost.Service;

/// <summary>
/// Long-lived client for the Service browser routing events pipe. Reconnects on disconnect; no caching.
/// </summary>
internal sealed class BrowserRoutingEventsPipeClient(string? pipeName = ServiceIpcV1.EventsPipeName) : IServiceEventsClient
{
    private static readonly JsonDocumentOptions JsonOptions = new() { MaxDepth = 8 };
    private static readonly TimeSpan ReconnectDelay = TimeSpan.FromMilliseconds(250);

    public async IAsyncEnumerable<ServicePushEvent> SubscribeAsync([System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken cancellationToken)
    {
        if (pipeName is null)
            yield break;

        while (!cancellationToken.IsCancellationRequested)
        {
            await foreach (var evt in ReadSessionAsync(cancellationToken).ConfigureAwait(false))
                yield return evt;

            try
            {
                await Task.Delay(ReconnectDelay, cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                yield break;
            }
        }
    }

    private async IAsyncEnumerable<ServicePushEvent> ReadSessionAsync(
        [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken cancellationToken)
    {
        var name = pipeName!;
        using var pipe = new NamedPipeClientStream(".", name, PipeDirection.InOut, PipeOptions.Asynchronous,
            TokenImpersonationLevel.Identification);
        try
        {
            await pipe.ConnectAsync(ServiceIpcV1.ConnectTimeout, cancellationToken).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is TimeoutException or IOException or UnauthorizedAccessException)
        {
            yield break;
        }

        if (!IsTrustedOwner(pipe))
            yield break;

        var subscribeId = Guid.NewGuid().ToString("N");
        var request = BuildSubscribeRequest(subscribeId);
        await WriteFrameAsync(pipe, request, cancellationToken).ConfigureAwait(false);
        var ack = await ReadFrameAsync(pipe, cancellationToken).ConfigureAwait(false);
        if (ack is null || !IsSubscribeAck(ack, subscribeId))
            yield break;

        while (!cancellationToken.IsCancellationRequested)
        {
            var frame = await ReadFrameAsync(pipe, cancellationToken).ConfigureAwait(false);
            if (frame is null)
                yield break;
            if (TryParseEvent(frame, out var evt))
                yield return evt;
        }
    }

    private static byte[] BuildSubscribeRequest(string id)
    {
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream))
        {
            writer.WriteStartObject();
            writer.WriteNumber("version", ServiceIpcV1.EventsVersion);
            writer.WriteString("id", id);
            writer.WriteString("method", ServiceIpcV1.EventsMethods.SubscribeEvents);
            writer.WriteEndObject();
        }
        return stream.ToArray();
    }

    private static bool IsSubscribeAck(byte[] body, string id)
    {
        try
        {
            using var document = JsonDocument.Parse(body, JsonOptions);
            var root = document.RootElement;
            return root.GetProperty("ok").GetBoolean()
                && root.GetProperty("id").GetString() == id;
        }
        catch (JsonException)
        {
            return false;
        }
    }

    internal static bool TryParseEvent(ReadOnlySpan<byte> body, out ServicePushEvent evt)
    {
        evt = default!;
        if (!Utf8.IsValid(body))
            return false;
        try
        {
            using var document = JsonDocument.Parse(body.ToArray(), JsonOptions);
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
                return false;
            var names = root.EnumerateObject().Select(p => p.Name).ToList();
            if (names.Count != 3 || names.Distinct(StringComparer.Ordinal).Count() != 3)
                return false;
            if (!root.TryGetProperty("type", out var type) || type.ValueKind != JsonValueKind.String)
                return false;
            var typeValue = type.GetString();
            if (typeValue is not (ServiceIpcV1.EventTypes.BrowserRoutingChanged or ServiceIpcV1.EventTypes.ServiceAvailable))
                return false;
            if (!root.TryGetProperty("stateGeneration", out var generation) ||
                generation.ValueKind != JsonValueKind.String ||
                !RequestDispatcher.IsGeneration(generation.GetString()))
                return false;
            if (!root.TryGetProperty("revision", out var revision) ||
                revision.ValueKind != JsonValueKind.Number ||
                !revision.TryGetInt64(out var rev) || rev < 0 || rev > ProtocolV1.MaxRevision)
                return false;
            evt = new ServicePushEvent(typeValue, generation.GetString()!, rev);
            return true;
        }
        catch (JsonException)
        {
            return false;
        }
    }

    private static async Task WriteFrameAsync(Stream pipe, byte[] body, CancellationToken cancellationToken)
    {
        var header = new byte[4];
        BinaryPrimitives.WriteInt32LittleEndian(header, body.Length);
        await pipe.WriteAsync(header, cancellationToken).ConfigureAwait(false);
        await pipe.WriteAsync(body, cancellationToken).ConfigureAwait(false);
        await pipe.FlushAsync(cancellationToken).ConfigureAwait(false);
    }

    private static async Task<byte[]?> ReadFrameAsync(Stream pipe, CancellationToken cancellationToken)
    {
        var header = new byte[4];
        if (!await ReadExactlyAsync(pipe, header, cancellationToken).ConfigureAwait(false))
            return null;
        var length = BinaryPrimitives.ReadInt32LittleEndian(header);
        if (length is <= 0 or > ServiceIpcV1.MaxEventBytes)
            return null;
        var body = new byte[length];
        if (!await ReadExactlyAsync(pipe, body, cancellationToken).ConfigureAwait(false))
            return null;
        return body;
    }

    private static bool IsTrustedOwner(NamedPipeClientStream pipe)
    {
        try
        {
            var owner = pipe.GetAccessControl().GetOwner(typeof(SecurityIdentifier)) as SecurityIdentifier;
            return BrowserRoutingPipeClient.IsTrustedOwner(owner, WindowsIdentity.GetCurrent().User);
        }
        catch (Exception ex) when (ex is UnauthorizedAccessException or InvalidOperationException or IOException)
        {
            return false;
        }
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
