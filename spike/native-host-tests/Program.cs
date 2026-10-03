using System.Buffers.Binary;
using System.Diagnostics;
using System.Text;
using System.Text.Json;

namespace VpnRoute.Phase0B.NativeHostTests;

internal static class Program
{
    private const string ExpectedHost = "SelectiveVpnRouter.NativeHost.Spike";
    private const string ExpectedVersion = "0.0.1";
    private const int MaxIncomingMessageBytes = 64 * 1024;
    private static readonly TimeSpan ProcessTimeout = TimeSpan.FromSeconds(15);

    public static async Task<int> Main(string[] args)
    {
        if (args.Length != 1)
        {
            Console.Error.WriteLine("usage: NativeHostProtocolTests <path-to-native-host.exe>");
            return 2;
        }

        var hostPath = Path.GetFullPath(args[0]);
        if (!File.Exists(hostPath))
        {
            Console.Error.WriteLine("native host not found: " + hostPath);
            return 2;
        }

        Console.WriteLine("host: " + hostPath);
        var tests = new (string Name, Func<string, Task> Run)[]
        {
            ("ping returns pong and preserves id", PingReturnsPong),
            ("unknown command", UnknownCommand),
            ("malformed JSON keeps process alive", MalformedJsonKeepsProcessAlive),
            ("invalid requests", InvalidRequests),
            ("multiple sequential messages", MultipleSequentialMessages),
            ("EOF before any message", EofBeforeAnyMessage),
            ("truncated length header", TruncatedLengthHeader),
            ("truncated payload", TruncatedPayload),
            ("message at size limit", MessageAtSizeLimit),
            ("oversized message", OversizedMessage),
            ("caller origin argument is not echoed to stdout", CallerOriginNotOnStdout)
        };

        var failed = 0;
        foreach (var (name, run) in tests)
        {
            try
            {
                await run(hostPath);
                Console.WriteLine("PASS " + name);
            }
            catch (Exception exception)
            {
                failed++;
                Console.WriteLine("FAIL " + name + ": " + exception.Message);
            }
        }

        Console.WriteLine(failed == 0 ? $"ALL {tests.Length} PASS" : $"{failed} of {tests.Length} FAILED");
        return failed == 0 ? 0 : 1;
    }

    private static async Task PingReturnsPong(string hostPath)
    {
        var result = await RunHostAsync(hostPath, Frame("""{"id":"ping-1","command":"ping"}"""));
        Expect(result.ExitCode == 0, "exit code " + result.ExitCode);
        var responses = ParseFrames(result.Stdout);
        Expect(responses.Count == 1, "responses " + responses.Count);
        ExpectPong(responses[0], "ping-1");
        Expect(result.Stderr.Contains("[nativehost]"), "diagnostics missing from stderr");
    }

    private static async Task UnknownCommand(string hostPath)
    {
        var result = await RunHostAsync(hostPath, Frame("""{"id":"u-1","command":"rm -rf"}"""));
        Expect(result.ExitCode == 0, "exit code " + result.ExitCode);
        var responses = ParseFrames(result.Stdout);
        Expect(responses.Count == 1, "responses " + responses.Count);
        ExpectError(responses[0], "u-1", "unknown_command");
        Expect(!responses[0].GetRawText().Contains("rm -rf"), "command text echoed back");
    }

    private static async Task MalformedJsonKeepsProcessAlive(string hostPath)
    {
        var input = Concat(
            Frame("""{"id":"""),
            FrameBytes([0xFF, 0xFE, 0x7B]),
            Frame("""{"id":"after-bad","command":"ping"}"""));
        var result = await RunHostAsync(hostPath, input);
        Expect(result.ExitCode == 0, "exit code " + result.ExitCode);
        var responses = ParseFrames(result.Stdout);
        Expect(responses.Count == 3, "responses " + responses.Count);
        ExpectError(responses[0], null, "malformed_json");
        ExpectError(responses[1], null, "malformed_json");
        ExpectPong(responses[2], "after-bad");
    }

    private static async Task InvalidRequests(string hostPath)
    {
        var input = Concat(
            Frame("""["ping"]"""),
            Frame("""{"command":"ping"}"""),
            Frame("""{"id":42,"command":"ping"}"""),
            Frame("""{"id":"","command":"ping"}"""),
            Frame("{\"id\":\"" + new string('x', 129) + "\",\"command\":\"ping\"}"),
            Frame("""{"id":"no-command"}"""),
            Frame("""{"id":"bad-command","command":1}"""),
            FrameBytes([]),
            Frame("""{"id":"still-alive","command":"ping"}"""));
        var result = await RunHostAsync(hostPath, input);
        Expect(result.ExitCode == 0, "exit code " + result.ExitCode);
        var responses = ParseFrames(result.Stdout);
        Expect(responses.Count == 9, "responses " + responses.Count);
        ExpectError(responses[0], null, "invalid_request");
        ExpectError(responses[1], null, "invalid_request");
        ExpectError(responses[2], null, "invalid_request");
        ExpectError(responses[3], null, "invalid_request");
        ExpectError(responses[4], null, "invalid_request");
        ExpectError(responses[5], "no-command", "invalid_request");
        ExpectError(responses[6], "bad-command", "invalid_request");
        ExpectError(responses[7], null, "invalid_message");
        ExpectPong(responses[8], "still-alive");
    }

    private static async Task MultipleSequentialMessages(string hostPath)
    {
        var input = Concat(
            Frame("""{"id":"a","command":"ping"}"""),
            Frame("""{"id":"b","command":"unknown"}"""),
            Frame("""{"id":"c","command":"ping"}"""));
        var result = await RunHostAsync(hostPath, input);
        Expect(result.ExitCode == 0, "exit code " + result.ExitCode);
        var responses = ParseFrames(result.Stdout);
        Expect(responses.Count == 3, "responses " + responses.Count);
        ExpectPong(responses[0], "a");
        ExpectError(responses[1], "b", "unknown_command");
        ExpectPong(responses[2], "c");
    }

    private static async Task EofBeforeAnyMessage(string hostPath)
    {
        var result = await RunHostAsync(hostPath, []);
        Expect(result.ExitCode == 0, "exit code " + result.ExitCode);
        Expect(result.Stdout.Length == 0, "stdout bytes " + result.Stdout.Length);
    }

    private static async Task TruncatedLengthHeader(string hostPath)
    {
        var result = await RunHostAsync(hostPath, [0x10, 0x00]);
        Expect(result.ExitCode == 3, "exit code " + result.ExitCode);
        Expect(result.Stdout.Length == 0, "stdout bytes " + result.Stdout.Length);
    }

    private static async Task TruncatedPayload(string hostPath)
    {
        var input = new byte[4 + 3];
        BinaryPrimitives.WriteUInt32LittleEndian(input, 10);
        input[4] = (byte)'{';
        input[5] = (byte)'"';
        input[6] = (byte)'i';
        var result = await RunHostAsync(hostPath, input);
        Expect(result.ExitCode == 3, "exit code " + result.ExitCode);
        Expect(result.Stdout.Length == 0, "stdout bytes " + result.Stdout.Length);
    }

    private static async Task MessageAtSizeLimit(string hostPath)
    {
        var json = """{"id":"limit","command":"ping"}""";
        var padded = json + new string(' ', MaxIncomingMessageBytes - Encoding.UTF8.GetByteCount(json));
        Expect(Encoding.UTF8.GetByteCount(padded) == MaxIncomingMessageBytes, "padding size");
        var result = await RunHostAsync(hostPath, Frame(padded));
        Expect(result.ExitCode == 0, "exit code " + result.ExitCode);
        var responses = ParseFrames(result.Stdout);
        Expect(responses.Count == 1, "responses " + responses.Count);
        ExpectPong(responses[0], "limit");
    }

    private static async Task OversizedMessage(string hostPath)
    {
        var input = new byte[4];
        BinaryPrimitives.WriteUInt32LittleEndian(input, MaxIncomingMessageBytes + 1);
        var result = await RunHostAsync(hostPath, Concat(input, Frame("""{"id":"never","command":"ping"}""")));
        Expect(result.ExitCode == 2, "exit code " + result.ExitCode);
        var responses = ParseFrames(result.Stdout);
        Expect(responses.Count == 1, "responses " + responses.Count);
        ExpectError(responses[0], null, "message_too_large");

        BinaryPrimitives.WriteUInt32LittleEndian(input, uint.MaxValue);
        result = await RunHostAsync(hostPath, input);
        Expect(result.ExitCode == 2, "uint.MaxValue exit code " + result.ExitCode);
        responses = ParseFrames(result.Stdout);
        Expect(responses.Count == 1, "uint.MaxValue responses " + responses.Count);
        ExpectError(responses[0], null, "message_too_large");
    }

    private static async Task CallerOriginNotOnStdout(string hostPath)
    {
        const string origin = "chrome-extension://onodojebmdbcndjelgfhoiffeojngmbd/";
        var result = await RunHostAsync(
            hostPath,
            Frame("""{"id":"origin","command":"ping"}"""),
            origin,
            "--parent-window=0");
        Expect(result.ExitCode == 0, "exit code " + result.ExitCode);
        var responses = ParseFrames(result.Stdout);
        Expect(responses.Count == 1, "responses " + responses.Count);
        ExpectPong(responses[0], "origin");
        Expect(result.Stderr.Contains(origin), "caller origin not logged to stderr");
        Expect(!Encoding.UTF8.GetString(result.Stdout).Contains("chrome-extension://"), "caller origin on stdout");
    }

    private static async Task<HostResult> RunHostAsync(string hostPath, byte[] input, params string[] args)
    {
        var startInfo = new ProcessStartInfo(hostPath)
        {
            UseShellExecute = false,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true
        };
        foreach (var arg in args)
            startInfo.ArgumentList.Add(arg);

        using var process = Process.Start(startInfo) ?? throw new InvalidOperationException("process did not start");
        using var timeout = new CancellationTokenSource(ProcessTimeout);
        var stdout = new MemoryStream();
        var stdoutTask = process.StandardOutput.BaseStream.CopyToAsync(stdout, timeout.Token);
        var stderrTask = process.StandardError.ReadToEndAsync(timeout.Token);

        try
        {
            var stdin = process.StandardInput.BaseStream;
            await stdin.WriteAsync(input, timeout.Token);
            await stdin.FlushAsync(timeout.Token);
        }
        catch (IOException)
        {
        }
        finally
        {
            try
            {
                process.StandardInput.Close();
            }
            catch (IOException)
            {
            }
        }

        try
        {
            await process.WaitForExitAsync(timeout.Token);
            await stdoutTask;
            var stderr = await stderrTask;
            return new HostResult(process.ExitCode, stdout.ToArray(), stderr);
        }
        catch (OperationCanceledException)
        {
            process.Kill(entireProcessTree: true);
            throw new TimeoutException("native host did not exit in time");
        }
    }

    private static List<JsonElement> ParseFrames(byte[] stdout)
    {
        var responses = new List<JsonElement>();
        var offset = 0;
        while (offset < stdout.Length)
        {
            if (stdout.Length - offset < 4)
                throw new InvalidOperationException($"stdout has {stdout.Length - offset} trailing bytes outside a frame");

            var length = BinaryPrimitives.ReadUInt32LittleEndian(stdout.AsSpan(offset, 4));
            offset += 4;
            if (length > stdout.Length - offset)
                throw new InvalidOperationException($"frame length {length} exceeds remaining stdout {stdout.Length - offset}");

            var payload = stdout.AsSpan(offset, (int)length);
            offset += (int)length;
            using var document = JsonDocument.Parse(payload.ToArray());
            responses.Add(document.RootElement.Clone());
        }

        return responses;
    }

    private static void ExpectPong(JsonElement response, string id)
    {
        Expect(response.ValueKind == JsonValueKind.Object, "response is not an object");
        Expect(response.GetProperty("id").GetString() == id, "id " + response.GetProperty("id"));
        Expect(response.GetProperty("ok").GetBoolean(), "ok is false: " + response.GetRawText());
        Expect(response.GetProperty("command").GetString() == "pong", "command " + response.GetProperty("command"));
        Expect(response.GetProperty("host").GetString() == ExpectedHost, "host " + response.GetProperty("host"));
        Expect(response.GetProperty("version").GetString() == ExpectedVersion, "version " + response.GetProperty("version"));
        Expect(CountProperties(response) == 5, "unexpected pong fields: " + response.GetRawText());
    }

    private static void ExpectError(JsonElement response, string? id, string code)
    {
        Expect(response.ValueKind == JsonValueKind.Object, "response is not an object");
        var actualId = response.GetProperty("id");
        if (id is null)
            Expect(actualId.ValueKind == JsonValueKind.Null, "id should be null: " + response.GetRawText());
        else
            Expect(actualId.GetString() == id, "id " + actualId);

        Expect(!response.GetProperty("ok").GetBoolean(), "ok is true: " + response.GetRawText());
        var error = response.GetProperty("error");
        Expect(error.GetProperty("code").GetString() == code, "code " + error.GetProperty("code") + ", expected " + code);
        Expect(error.GetProperty("message").ValueKind == JsonValueKind.String, "error message missing");
    }

    private static int CountProperties(JsonElement element)
    {
        var count = 0;
        foreach (var _ in element.EnumerateObject())
            count++;
        return count;
    }

    private static byte[] Frame(string json) => FrameBytes(Encoding.UTF8.GetBytes(json));

    private static byte[] FrameBytes(byte[] payload)
    {
        var frame = new byte[4 + payload.Length];
        BinaryPrimitives.WriteUInt32LittleEndian(frame, (uint)payload.Length);
        payload.CopyTo(frame, 4);
        return frame;
    }

    private static byte[] Concat(params byte[][] parts) => parts.SelectMany(static part => part).ToArray();

    private static void Expect(bool condition, string message)
    {
        if (!condition)
            throw new InvalidOperationException(message);
    }

    private sealed record HostResult(int ExitCode, byte[] Stdout, string Stderr);
}
