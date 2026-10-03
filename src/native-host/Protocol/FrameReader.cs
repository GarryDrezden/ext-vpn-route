using System.Buffers.Binary;

namespace VpnRoute.NativeHost.Protocol;

internal enum FrameKind
{
    Message,
    Eof,
    Empty,
    TooLarge,
    TruncatedHeader,
    TruncatedPayload
}

internal readonly record struct Frame(FrameKind Kind, byte[]? Payload, uint DeclaredLength);

/// <summary>Reads Chromium native messaging frames: 4-byte little-endian length, then UTF-8 JSON.</summary>
internal sealed class FrameReader(Stream input, int maxPayloadBytes)
{
    private readonly byte[] header = new byte[4];

    public async Task<Frame> ReadAsync(CancellationToken cancellationToken)
    {
        var headerRead = await ReadUpToAsync(header, cancellationToken).ConfigureAwait(false);
        if (headerRead == 0)
            return new Frame(FrameKind.Eof, null, 0);
        if (headerRead < header.Length)
            return new Frame(FrameKind.TruncatedHeader, null, 0);

        var length = BinaryPrimitives.ReadUInt32LittleEndian(header);
        if (length == 0)
            return new Frame(FrameKind.Empty, null, 0);
        if (length > (uint)maxPayloadBytes)
            return new Frame(FrameKind.TooLarge, null, length);

        var payload = new byte[length];
        var payloadRead = await ReadUpToAsync(payload, cancellationToken).ConfigureAwait(false);
        return payloadRead < payload.Length
            ? new Frame(FrameKind.TruncatedPayload, null, length)
            : new Frame(FrameKind.Message, payload, length);
    }

    private async Task<int> ReadUpToAsync(byte[] buffer, CancellationToken cancellationToken)
    {
        var offset = 0;
        while (offset < buffer.Length)
        {
            var read = await input.ReadAsync(buffer.AsMemory(offset), cancellationToken).ConfigureAwait(false);
            if (read == 0)
                break;
            offset += read;
        }
        return offset;
    }
}
