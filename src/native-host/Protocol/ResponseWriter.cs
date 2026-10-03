using System.Buffers;
using System.Text.Json;

namespace VpnRoute.NativeHost.Protocol;

/// <summary>Serializes v1 response envelopes. Error messages are fixed per code and never contain request data.</summary>
internal static class ResponseWriter
{
    private static readonly Dictionary<string, string> ErrorMessages = new(StringComparer.Ordinal)
    {
        [ProtocolV1.Errors.InvalidMessage] = "Empty native message.",
        [ProtocolV1.Errors.MessageTooLarge] = "Native message exceeds the size limit.",
        [ProtocolV1.Errors.MalformedJson] = "Native message is not valid UTF-8 JSON.",
        [ProtocolV1.Errors.InvalidRequest] = "Request envelope is invalid.",
        [ProtocolV1.Errors.UnsupportedProtocolVersion] = "Protocol version is not supported.",
        [ProtocolV1.Errors.UnknownCommand] = "Command is not supported.",
        [ProtocolV1.Errors.ForbiddenOrigin] = "Caller origin is not allowed.",
        [ProtocolV1.Errors.ServiceUnavailable] = "VPN Route Service is unavailable.",
        [ProtocolV1.Errors.ServiceTimeout] = "VPN Route Service did not respond in time.",
        [ProtocolV1.Errors.ServiceError] = "VPN Route Service request failed.",
        [ProtocolV1.Errors.InvalidServiceResponse] = "VPN Route Service returned an invalid state snapshot.",
        [ProtocolV1.Errors.ResponseTooLarge] = "State snapshot exceeds the native messaging size limit.",
        [ProtocolV1.Errors.InternalError] = "Native host internal error."
    };

    public static byte[] Success(string requestId, Action<Utf8JsonWriter> writeResult)
    {
        return Write(writer =>
        {
            WriteHead(writer, requestId, ok: true);
            writer.WritePropertyName("result");
            writeResult(writer);
        });
    }

    public static byte[] Error(string? requestId, string code)
    {
        if (!ErrorMessages.TryGetValue(code, out var message))
            throw new ArgumentOutOfRangeException(nameof(code));

        return Write(writer =>
        {
            WriteHead(writer, requestId, ok: false);
            writer.WriteStartObject("error");
            writer.WriteString("code", code);
            writer.WriteString("message", message);
            writer.WriteEndObject();
        });
    }

    public static IReadOnlyCollection<string> KnownErrorCodes => ErrorMessages.Keys;

    private static void WriteHead(Utf8JsonWriter writer, string? requestId, bool ok)
    {
        writer.WriteNumber("protocolVersion", ProtocolV1.Version);
        if (requestId is null)
            writer.WriteNull("requestId");
        else
            writer.WriteString("requestId", requestId);
        writer.WriteBoolean("ok", ok);
    }

    private static byte[] Write(Action<Utf8JsonWriter> body)
    {
        var buffer = new ArrayBufferWriter<byte>();
        using (var writer = new Utf8JsonWriter(buffer))
        {
            writer.WriteStartObject();
            body(writer);
            writer.WriteEndObject();
        }
        return buffer.WrittenSpan.ToArray();
    }
}
