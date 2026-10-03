using System.Buffers;
using System.Buffers.Binary;
using System.Text.Json;

namespace VpnRoute.Phase0B.NativeHost;

internal static class Program
{
    internal const string HostName = "SelectiveVpnRouter.NativeHost.Spike";
    internal const string HostVersion = "0.0.1";
    internal const int MaxIncomingMessageBytes = 64 * 1024;
    private const int MaxOutgoingMessageBytes = 1024 * 1024;
    private const int MaxIdLength = 128;

    private const int ExitCleanEof = 0;
    private const int ExitUnexpected = 1;
    private const int ExitMessageTooLarge = 2;
    private const int ExitTruncatedFrame = 3;

    private static readonly JsonDocumentOptions ParseOptions = new()
    {
        MaxDepth = 16,
        AllowTrailingCommas = false,
        CommentHandling = JsonCommentHandling.Disallow
    };

    public static int Main(string[] args)
    {
        var stdin = Console.OpenStandardInput();
        var stdout = Console.OpenStandardOutput();
        Console.SetOut(Console.Error);

        Log("start " + HostName + " " + HostVersion);
        if (args.Length > 0)
            Log("caller " + args[0]);

        try
        {
            return Run(stdin, stdout);
        }
        catch (Exception exception)
        {
            Log("fatal " + exception.GetType().Name + ": " + exception.Message);
            return ExitUnexpected;
        }
    }

    private static int Run(Stream stdin, Stream stdout)
    {
        var header = new byte[4];
        while (true)
        {
            var headerRead = ReadUpTo(stdin, header);
            if (headerRead == 0)
            {
                Log("stdin closed, exit");
                return ExitCleanEof;
            }

            if (headerRead < header.Length)
            {
                Log($"truncated length header: {headerRead} of 4 bytes");
                return ExitTruncatedFrame;
            }

            var length = BinaryPrimitives.ReadUInt32LittleEndian(header);
            if (length == 0)
            {
                Log("empty message");
                WriteMessage(stdout, writer => WriteError(writer, null, "invalid_message", "Message is empty."));
                continue;
            }

            if (length > MaxIncomingMessageBytes)
            {
                Log($"message too large: {length} bytes, limit {MaxIncomingMessageBytes}");
                WriteMessage(stdout, writer => WriteError(
                    writer,
                    null,
                    "message_too_large",
                    $"Message exceeds {MaxIncomingMessageBytes} bytes."));
                return ExitMessageTooLarge;
            }

            var payload = new byte[length];
            var payloadRead = ReadUpTo(stdin, payload);
            if (payloadRead < payload.Length)
            {
                Log($"truncated payload: {payloadRead} of {length} bytes");
                return ExitTruncatedFrame;
            }

            HandleMessage(stdout, payload);
        }
    }

    private static void HandleMessage(Stream stdout, byte[] payload)
    {
        JsonDocument document;
        try
        {
            document = JsonDocument.Parse(payload, ParseOptions);
        }
        catch (JsonException)
        {
            Log("malformed JSON");
            WriteMessage(stdout, writer => WriteError(writer, null, "malformed_json", "Message is not valid JSON."));
            return;
        }

        using (document)
        {
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
            {
                Log("request is not an object");
                WriteMessage(stdout, writer => WriteError(writer, null, "invalid_request", "Request must be a JSON object."));
                return;
            }

            if (!root.TryGetProperty("id", out var idElement) ||
                idElement.ValueKind != JsonValueKind.String ||
                idElement.GetString() is not { Length: > 0 and <= MaxIdLength } id)
            {
                Log("request id is missing or invalid");
                WriteMessage(stdout, writer => WriteError(
                    writer,
                    null,
                    "invalid_request",
                    $"Field 'id' must be a non-empty string up to {MaxIdLength} characters."));
                return;
            }

            if (!root.TryGetProperty("command", out var commandElement) ||
                commandElement.ValueKind != JsonValueKind.String)
            {
                Log($"request {id}: command is missing or invalid");
                WriteMessage(stdout, writer => WriteError(writer, id, "invalid_request", "Field 'command' must be a string."));
                return;
            }

            var command = commandElement.GetString();
            if (command == "ping")
            {
                Log($"request {id}: ping -> pong");
                WriteMessage(stdout, writer => WritePong(writer, id));
                return;
            }

            Log($"request {id}: unknown command");
            WriteMessage(stdout, writer => WriteError(writer, id, "unknown_command", "Command is not supported by this host."));
        }
    }

    private static void WritePong(Utf8JsonWriter writer, string id)
    {
        writer.WriteStartObject();
        writer.WriteString("id", id);
        writer.WriteBoolean("ok", true);
        writer.WriteString("command", "pong");
        writer.WriteString("host", HostName);
        writer.WriteString("version", HostVersion);
        writer.WriteEndObject();
    }

    private static void WriteError(Utf8JsonWriter writer, string? id, string code, string message)
    {
        writer.WriteStartObject();
        if (id is null)
            writer.WriteNull("id");
        else
            writer.WriteString("id", id);

        writer.WriteBoolean("ok", false);
        writer.WritePropertyName("error");
        writer.WriteStartObject();
        writer.WriteString("code", code);
        writer.WriteString("message", message);
        writer.WriteEndObject();
        writer.WriteEndObject();
    }

    private static void WriteMessage(Stream stdout, Action<Utf8JsonWriter> write)
    {
        var buffer = new ArrayBufferWriter<byte>();
        using (var writer = new Utf8JsonWriter(buffer))
            write(writer);

        if (buffer.WrittenCount > MaxOutgoingMessageBytes)
            throw new InvalidOperationException("response exceeds Chrome native messaging limit");

        var header = new byte[4];
        BinaryPrimitives.WriteUInt32LittleEndian(header, (uint)buffer.WrittenCount);
        stdout.Write(header);
        stdout.Write(buffer.WrittenSpan);
        stdout.Flush();
    }

    private static int ReadUpTo(Stream stream, byte[] buffer)
    {
        var offset = 0;
        while (offset < buffer.Length)
        {
            var read = stream.Read(buffer, offset, buffer.Length - offset);
            if (read == 0)
                break;

            offset += read;
        }

        return offset;
    }

    private static void Log(string message) =>
        Console.Error.WriteLine("[nativehost] " + message);
}
