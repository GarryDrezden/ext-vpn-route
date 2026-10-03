using System.Buffers.Binary;

namespace VpnRoute.NativeHost.Protocol;

/// <summary>The only writer of stdout. Everything it writes is a complete native messaging frame.</summary>
internal sealed class FrameWriter(Stream output)
{
    public async Task WriteAsync(ReadOnlyMemory<byte> payload, CancellationToken cancellationToken)
    {
        if (payload.Length > ProtocolV1.MaxResponseBytes)
            throw new InvalidOperationException("Response exceeds the native messaging limit.");

        var header = new byte[4];
        BinaryPrimitives.WriteUInt32LittleEndian(header, (uint)payload.Length);
        await output.WriteAsync(header, cancellationToken).ConfigureAwait(false);
        await output.WriteAsync(payload, cancellationToken).ConfigureAwait(false);
        await output.FlushAsync(cancellationToken).ConfigureAwait(false);
    }
}
