using System.Buffers.Binary;
using System.Text;
using System.Text.Json;

namespace VpnRoute.NativeHost.Tests.Support;

internal static class Frames
{
    public static byte[] Of(string json) => Raw(Encoding.UTF8.GetBytes(json));

    public static byte[] Raw(byte[] payload)
    {
        var frame = new byte[4 + payload.Length];
        BinaryPrimitives.WriteUInt32LittleEndian(frame, (uint)payload.Length);
        payload.CopyTo(frame, 4);
        return frame;
    }

    public static byte[] Header(uint length)
    {
        var header = new byte[4];
        BinaryPrimitives.WriteUInt32LittleEndian(header, length);
        return header;
    }

    public static byte[] Concat(params byte[][] parts) => parts.SelectMany(p => p).ToArray();

    public static string Request(string command, string requestId = "req-1", int protocolVersion = 1) =>
        JsonSerializer.Serialize(new { protocolVersion, requestId, command });

    /// <summary>Parses stdout strictly: it must be a sequence of complete frames and nothing else.</summary>
    public static List<JsonElement> Parse(byte[] stdout)
    {
        var result = new List<JsonElement>();
        var offset = 0;
        while (offset < stdout.Length)
        {
            Assert.True(stdout.Length - offset >= 4, "stdout ends with a partial frame header");
            var length = (int)BinaryPrimitives.ReadUInt32LittleEndian(stdout.AsSpan(offset, 4));
            offset += 4;
            Assert.True(stdout.Length - offset >= length, "stdout ends with a partial frame payload");
            using var document = JsonDocument.Parse(stdout.AsMemory(offset, length));
            result.Add(document.RootElement.Clone());
            offset += length;
        }
        return result;
    }

    public static string[] Keys(JsonElement element) =>
        element.EnumerateObject().Select(p => p.Name).ToArray();
}
