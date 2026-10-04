using System.Buffers.Binary;
using System.IO.Pipes;
using System.Security.Principal;
using System.Text;
using VpnRoute.NativeHost.Service;

namespace VpnRoute.NativeHost.Tests.Support;

[CollectionDefinition(Name, DisableParallelization = true)]
public sealed class ServicePipeCollection
{
    public const string Name = "Service pipe";
}

/// <summary>
/// Minimal stand-in for the Service end of the browser routing pipe, on a private name in the
/// test pipe namespace (the real Service may own the production name). The handler gets the
/// request payload and returns the raw bytes to write back (header included), or null to close
/// without answering.
/// </summary>
internal sealed class FakeServicePipe : IAsyncDisposable
{
    private readonly CancellationTokenSource _stop = new();
    private readonly Task _loop;

    public FakeServicePipe(Func<byte[], Task<byte[]?>> handler)
    {
        var first = CreateInstance(first: true);
        _loop = Task.Run(() => LoopAsync(first, handler));
    }

    public string Name { get; } = NewTestPipeName();

    public List<byte[]> Requests { get; } = [];
    public List<TokenImpersonationLevel> ClientLevels { get; } = [];

    public static string NewTestPipeName() => $"{ServiceIpcV1.PipeName}.Test.{Guid.NewGuid():N}";

    public static byte[] Frame(string json)
    {
        var body = Encoding.UTF8.GetBytes(json);
        var frame = new byte[4 + body.Length];
        BinaryPrimitives.WriteInt32LittleEndian(frame, body.Length);
        body.CopyTo(frame, 4);
        return frame;
    }

    public static string Ok(string id, string result) => $$"""{"version":1,"id":"{{id}}","ok":true,"result":{{result}}}""";

    public static string Error(string id, string code) => $$$"""{"version":1,"id":"{{{id}}}","ok":false,"error":{"code":"{{{code}}}"}}""";

    public static string RequestId(byte[] request)
    {
        using var document = System.Text.Json.JsonDocument.Parse(request);
        return document.RootElement.GetProperty("id").GetString()!;
    }

    private NamedPipeServerStream CreateInstance(bool first) => new(
        Name, PipeDirection.InOut, 4, PipeTransmissionMode.Byte,
        PipeOptions.Asynchronous | (first ? PipeOptions.FirstPipeInstance : PipeOptions.None));

    private async Task LoopAsync(NamedPipeServerStream pipe, Func<byte[], Task<byte[]?>> handler)
    {
        while (!_stop.IsCancellationRequested)
        {
            try
            {
                await pipe.WaitForConnectionAsync(_stop.Token);
                var next = CreateInstance(first: false);
                await ServeAsync(pipe, handler);
                pipe = next;
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch (IOException)
            {
                await pipe.DisposeAsync();
                pipe = CreateInstance(first: false);
            }
        }
        await pipe.DisposeAsync();
    }

    private async Task ServeAsync(NamedPipeServerStream pipe, Func<byte[], Task<byte[]?>> handler)
    {
        await using (pipe)
        {
            var header = new byte[4];
            await pipe.ReadExactlyAsync(header, _stop.Token);
            var body = new byte[BinaryPrimitives.ReadInt32LittleEndian(header)];
            await pipe.ReadExactlyAsync(body, _stop.Token);
            TokenImpersonationLevel level = TokenImpersonationLevel.None;
            pipe.RunAsClient(() => level = WindowsIdentity.GetCurrent(TokenAccessLevels.Query).ImpersonationLevel);
            lock (Requests)
            {
                Requests.Add(body);
                ClientLevels.Add(level);
            }
            var response = await handler(body);
            if (response is not null)
            {
                await pipe.WriteAsync(response, _stop.Token);
                await pipe.FlushAsync(_stop.Token);
                pipe.WaitForPipeDrain();
            }
        }
    }

    public async ValueTask DisposeAsync()
    {
        await _stop.CancelAsync();
        try
        {
            await _loop;
        }
        catch (Exception ex) when (ex is OperationCanceledException or IOException)
        {
        }
        _stop.Dispose();
    }
}
