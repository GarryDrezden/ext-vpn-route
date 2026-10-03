using System.Net;
using System.Net.Sockets;
using System.Text;

namespace VpnRoute.Phase0.Socks5Logger;

internal static class Program
{
    internal const int ListenPort = 17891;
    private static readonly IPAddress ListenAddress = IPAddress.Loopback;
    private static readonly TimeSpan HandshakeTimeout = TimeSpan.FromSeconds(5);
    private static readonly byte[] NoAuthReply = [0x05, 0x00];
    private static readonly byte[] NoAcceptableMethodReply = [0x05, 0xFF];
    private static readonly byte[] FailureReply =
    [
        0x05, 0x01, 0x00, 0x01,
        0x00, 0x00, 0x00, 0x00,
        0x00, 0x00
    ];

    private static readonly object ConsoleLock = new();
    private static int _nextConnectionId;

    public static async Task<int> Main(string[] args)
    {
        if (args.Contains("--self-test"))
            return await RunSelfTestAsync();

        using var shutdown = new CancellationTokenSource();
        Console.CancelKeyPress += (_, eventArgs) =>
        {
            eventArgs.Cancel = true;
            shutdown.Cancel();
            LogLine("shutdown requested");
        };

        try
        {
            await RunServerAsync(shutdown.Token);
            return 0;
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            Console.Error.WriteLine("listener failed: " + exception.Message);
            return 1;
        }
    }

    private static async Task RunServerAsync(CancellationToken shutdown, TaskCompletionSource? ready = null)
    {
        using var listener = new TcpListener(ListenAddress, ListenPort);
        try
        {
            listener.Start();
            var local = (IPEndPoint)listener.LocalEndpoint;
            if (!IPAddress.IsLoopback(local.Address))
                throw new InvalidOperationException("refusing non-loopback listener " + local.Address);

            LogLine($"SOCKS5 logger listening on {local.Address}:{local.Port}");
            LogLine("diagnostic sink only: no DNS, no forwarding");
            ready?.TrySetResult();

            while (!shutdown.IsCancellationRequested)
            {
                TcpClient client;
                try
                {
                    client = await listener.AcceptTcpClientAsync(shutdown);
                }
                catch (OperationCanceledException)
                {
                    break;
                }
                catch (ObjectDisposedException)
                {
                    break;
                }
                catch (SocketException) when (shutdown.IsCancellationRequested)
                {
                    break;
                }

                _ = Task.Run(() => HandleClientAsync(client), CancellationToken.None);
            }
        }
        catch (Exception exception)
        {
            ready?.TrySetException(exception);
            throw;
        }
        finally
        {
            listener.Stop();
            LogLine("listener stopped");
        }
    }

    private static async Task HandleClientAsync(TcpClient client)
    {
        var id = Interlocked.Increment(ref _nextConnectionId);
        var remote = client.Client.RemoteEndPoint?.ToString() ?? "unknown";
        using (client)
        {
            try
            {
                using var timeout = new CancellationTokenSource(HandshakeTimeout);
                client.ReceiveTimeout = (int)HandshakeTimeout.TotalMilliseconds;
                client.SendTimeout = (int)HandshakeTimeout.TotalMilliseconds;
                await using var stream = client.GetStream();
                var request = await ReadRequestAsync(stream, timeout.Token);
                LogRequest(id, remote, request);
                await stream.WriteAsync(FailureReply, timeout.Token);
                LogLine($"[connection #{id}] result: general SOCKS server failure, closed");
            }
            catch (OperationCanceledException)
            {
                LogLine($"""
                    [connection #{id}]
                    client: {remote}
                    error: handshake timed out
                    """);
            }
            catch (MalformedFrameException exception)
            {
                LogLine($"""
                    [connection #{id}]
                    client: {remote}
                    error: malformed frame: {exception.Message}
                    """);
            }
            catch (Exception exception)
            {
                LogLine($"""
                    [connection #{id}]
                    client: {remote}
                    error: {exception.GetType().Name}: {exception.Message}
                    """);
            }
        }
    }

    private static async Task<SocksRequest> ReadRequestAsync(Stream stream, CancellationToken cancellationToken)
    {
        var greetingHead = new byte[2];
        await ReadExactAsync(stream, greetingHead, cancellationToken);
        if (greetingHead[0] != 0x05)
            throw new MalformedFrameException($"VER=0x{greetingHead[0]:X2}, expected 0x05");

        var methodCount = greetingHead[1];
        if (methodCount == 0)
            throw new MalformedFrameException("NMETHODS is 0");

        var methods = new byte[methodCount];
        await ReadExactAsync(stream, methods, cancellationToken);
        if (!methods.Contains((byte)0x00))
        {
            await stream.WriteAsync(NoAcceptableMethodReply, cancellationToken);
            throw new MalformedFrameException("NO AUTH method was not offered");
        }

        await stream.WriteAsync(NoAuthReply, cancellationToken);

        var header = new byte[4];
        await ReadExactAsync(stream, header, cancellationToken);
        if (header[0] != 0x05)
            throw new MalformedFrameException($"request VER=0x{header[0]:X2}, expected 0x05");
        if (header[2] != 0x00)
            throw new MalformedFrameException($"RSV=0x{header[2]:X2}, expected 0x00");

        var (atyp, destination) = await ReadAddressAsync(stream, header[3], cancellationToken);
        var portBytes = new byte[2];
        await ReadExactAsync(stream, portBytes, cancellationToken);
        var port = (portBytes[0] << 8) | portBytes[1];
        return new SocksRequest("SOCKS5", DescribeCommand(header[1]), atyp, destination, port);
    }

    private static async Task<(string Atyp, string Destination)> ReadAddressAsync(
        Stream stream,
        byte atyp,
        CancellationToken cancellationToken)
    {
        switch (atyp)
        {
            case 0x01:
            {
                var address = new byte[4];
                await ReadExactAsync(stream, address, cancellationToken);
                return ("IPv4", new IPAddress(address).ToString());
            }
            case 0x03:
            {
                var lengthBytes = new byte[1];
                await ReadExactAsync(stream, lengthBytes, cancellationToken);
                if (lengthBytes[0] == 0)
                    throw new MalformedFrameException("domain length is 0");

                var domain = new byte[lengthBytes[0]];
                await ReadExactAsync(stream, domain, cancellationToken);
                return ("DOMAIN", FormatDomain(domain));
            }
            case 0x04:
            {
                var address = new byte[16];
                await ReadExactAsync(stream, address, cancellationToken);
                return ("IPv6", new IPAddress(address).ToString());
            }
            default:
                throw new MalformedFrameException($"unsupported ATYP=0x{atyp:X2}");
        }
    }

    private static async Task ReadExactAsync(Stream stream, byte[] buffer, CancellationToken cancellationToken)
    {
        var offset = 0;
        while (offset < buffer.Length)
        {
            var read = await stream.ReadAsync(buffer.AsMemory(offset, buffer.Length - offset), cancellationToken);
            if (read == 0)
                throw new MalformedFrameException($"connection closed after {offset} of {buffer.Length} bytes");

            offset += read;
        }
    }

    private static string DescribeCommand(byte command) => command switch
    {
        0x01 => "CONNECT",
        0x02 => "BIND",
        0x03 => "UDP ASSOCIATE",
        _ => $"UNKNOWN 0x{command:X2}"
    };

    private static string FormatDomain(byte[] domain)
    {
        if (domain.All(static value => value is >= 33 and <= 126))
            return Encoding.ASCII.GetString(domain);

        return "0x" + Convert.ToHexString(domain);
    }

    private static void LogRequest(int id, string remote, SocksRequest request)
    {
        LogLine($"""
            [connection #{id}]
            client: {remote}
            version: {request.Version}
            command: {request.Command}
            atyp: {request.Atyp}
            destination: {request.Destination}
            port: {request.Port}
            ATYP={request.Atyp} destination={request.Destination} port={request.Port}
            """);
    }

    private static void LogLine(string text)
    {
        lock (ConsoleLock)
            Console.WriteLine(text);
    }

    private static async Task<int> RunSelfTestAsync()
    {
        var failures = new List<string>();
        try
        {
            await TestParsersAsync(failures);
            await TestLiveAsync(failures);
        }
        catch (Exception exception)
        {
            failures.Add(exception.GetType().Name + ": " + exception.Message);
        }

        if (failures.Count == 0)
        {
            Console.WriteLine("SELF-CHECK PASS");
            Console.WriteLine("ATYP=DOMAIN destination=www.youtube.com port=443");
            return 0;
        }

        Console.Error.WriteLine("SELF-CHECK FAIL");
        foreach (var failure in failures)
            Console.Error.WriteLine(failure);
        return 1;
    }

    private static async Task TestParsersAsync(List<string> failures)
    {
        await ExpectRequestAsync(
            failures,
            BuildDomainHandshake("www.youtube.com", 443),
            "DOMAIN",
            "www.youtube.com",
            443);
        await ExpectRequestAsync(
            failures,
            BuildAddressHandshake(0x01, [1, 2, 3, 4], 80),
            "IPv4",
            "1.2.3.4",
            80);

        var ipv6 = new byte[16];
        ipv6[15] = 1;
        await ExpectRequestAsync(
            failures,
            BuildAddressHandshake(0x04, ipv6, 443),
            "IPv6",
            "::1",
            443);

        try
        {
            await ReadRequestAsync(new MemoryStream([0x05, 0x01]), CancellationToken.None);
            failures.Add("truncated greeting was accepted");
        }
        catch (MalformedFrameException)
        {
        }
    }

    private static async Task ExpectRequestAsync(
        List<string> failures,
        byte[] handshake,
        string atyp,
        string destination,
        int port)
    {
        try
        {
            var stream = new DuplexBuffer(handshake);
            var request = await ReadRequestAsync(stream, CancellationToken.None);
            if (request.Atyp != atyp || request.Destination != destination || request.Port != port)
            {
                failures.Add(
                    $"parser {destination}:{port} returned ATYP={request.Atyp} destination={request.Destination} port={request.Port}");
            }
            else if (!StartsWith(stream.Written, NoAuthReply))
            {
                failures.Add($"parser {destination}:{port} did not reply NO AUTH");
            }
        }
        catch (Exception exception)
        {
            failures.Add($"parser {destination}:{port} threw {exception.GetType().Name}: {exception.Message}");
        }
    }

    private static async Task TestLiveAsync(List<string> failures)
    {
        using var shutdown = new CancellationTokenSource();
        var ready = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var server = Task.Run(() => RunServerAsync(shutdown.Token, ready));

        try
        {
            await ready.Task.WaitAsync(TimeSpan.FromSeconds(3));
            var domainReply = await SendAndReadReplyAsync(BuildDomainHandshake("www.youtube.com", 443));
            if (!IsFailureReply(domainReply))
                failures.Add("live DOMAIN failure reply was " + Convert.ToHexString(domainReply));

            using (var broken = new TcpClient())
            {
                await broken.ConnectAsync(ListenAddress, ListenPort);
                await broken.GetStream().WriteAsync(new byte[] { 0x05 });
            }

            var ipv4Reply = await SendAndReadReplyAsync(BuildAddressHandshake(0x01, [1, 2, 3, 4], 80));
            if (!IsFailureReply(ipv4Reply))
                failures.Add("live second connection reply was " + Convert.ToHexString(ipv4Reply));
        }
        catch (Exception exception)
        {
            failures.Add("live handshake failed: " + exception.GetType().Name + ": " + exception.Message);
        }
        finally
        {
            shutdown.Cancel();
            try
            {
                await server.WaitAsync(TimeSpan.FromSeconds(3));
            }
            catch (Exception exception)
            {
                failures.Add("listener shutdown failed: " + exception.GetType().Name + ": " + exception.Message);
            }
        }
    }

    private static async Task<byte[]> SendAndReadReplyAsync(byte[] handshake)
    {
        using var client = new TcpClient();
        using var timeout = new CancellationTokenSource(HandshakeTimeout);
        await client.ConnectAsync(ListenAddress, ListenPort, timeout.Token);
        await using var stream = client.GetStream();
        await stream.WriteAsync(handshake, timeout.Token);
        var methodSelection = new byte[NoAuthReply.Length];
        await ReadExactAsync(stream, methodSelection, timeout.Token);
        if (!StartsWith(methodSelection, NoAuthReply))
            throw new InvalidOperationException("method selection was " + Convert.ToHexString(methodSelection));

        var reply = new byte[FailureReply.Length];
        await ReadExactAsync(stream, reply, timeout.Token);
        return reply;
    }

    private static bool IsFailureReply(byte[] reply) =>
        reply.Length == FailureReply.Length && reply[0] == 0x05 && reply[1] == 0x01;

    private static bool StartsWith(byte[] value, byte[] prefix)
    {
        if (value.Length < prefix.Length)
            return false;

        for (var index = 0; index < prefix.Length; index++)
        {
            if (value[index] != prefix[index])
                return false;
        }

        return true;
    }

    private static byte[] BuildDomainHandshake(string host, int port)
    {
        var domain = Encoding.ASCII.GetBytes(host);
        using var buffer = new MemoryStream();
        WriteGreeting(buffer);
        buffer.WriteByte(0x05);
        buffer.WriteByte(0x01);
        buffer.WriteByte(0x00);
        buffer.WriteByte(0x03);
        buffer.WriteByte((byte)domain.Length);
        buffer.Write(domain);
        buffer.WriteByte((byte)(port >> 8));
        buffer.WriteByte((byte)port);
        return buffer.ToArray();
    }

    private static byte[] BuildAddressHandshake(byte atyp, byte[] address, int port)
    {
        using var buffer = new MemoryStream();
        WriteGreeting(buffer);
        buffer.WriteByte(0x05);
        buffer.WriteByte(0x01);
        buffer.WriteByte(0x00);
        buffer.WriteByte(atyp);
        buffer.Write(address);
        buffer.WriteByte((byte)(port >> 8));
        buffer.WriteByte((byte)port);
        return buffer.ToArray();
    }

    private static void WriteGreeting(Stream buffer)
    {
        buffer.WriteByte(0x05);
        buffer.WriteByte(0x01);
        buffer.WriteByte(0x00);
    }

    private sealed record SocksRequest(string Version, string Command, string Atyp, string Destination, int Port);

    private sealed class MalformedFrameException : Exception
    {
        public MalformedFrameException(string message) : base(message)
        {
        }
    }

    private sealed class DuplexBuffer : Stream
    {
        private readonly MemoryStream _input;
        private readonly MemoryStream _output = new();

        public DuplexBuffer(byte[] input) => _input = new MemoryStream(input);

        public byte[] Written => _output.ToArray();

        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => true;
        public override long Length => throw new NotSupportedException();
        public override long Position
        {
            get => throw new NotSupportedException();
            set => throw new NotSupportedException();
        }

        public override void Flush()
        {
        }

        public override int Read(byte[] buffer, int offset, int count) => _input.Read(buffer, offset, count);

        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();

        public override void SetLength(long value) => throw new NotSupportedException();

        public override void Write(byte[] buffer, int offset, int count) => _output.Write(buffer, offset, count);

        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default) =>
            ValueTask.FromResult(_input.Read(buffer.Span));

        public override ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken cancellationToken = default)
        {
            _output.Write(buffer.Span);
            return ValueTask.CompletedTask;
        }
    }
}
