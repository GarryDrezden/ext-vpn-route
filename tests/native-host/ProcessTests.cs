using System.Diagnostics;
using System.Text;
using VpnRoute.NativeHost.Protocol;
using VpnRoute.NativeHost.Security;
using VpnRoute.NativeHost.Tests.Support;

namespace VpnRoute.NativeHost.Tests;

/// <summary>Runs the real host executable. NATIVE_HOST_EXE selects a published binary; default is the build output.</summary>
public class ProcessTests
{
    private sealed record ProcessRun(int ExitCode, byte[] Stdout, string Stderr);

    private static string HostExecutable()
    {
        var configured = Environment.GetEnvironmentVariable("NATIVE_HOST_EXE");
        var path = string.IsNullOrEmpty(configured)
            ? Path.Combine(AppContext.BaseDirectory, "SelectiveVpnRouter.NativeHost.exe")
            : configured;
        Assert.True(File.Exists(path), $"host executable not found: {path}");
        return path;
    }

    private static async Task<ProcessRun> RunAsync(byte[] stdin, params string[] args)
    {
        var info = new ProcessStartInfo(HostExecutable())
        {
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true
        };
        foreach (var arg in args)
            info.ArgumentList.Add(arg);

        using var process = Process.Start(info)!;
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        var stdoutTask = Task.Run(async () =>
        {
            using var buffer = new MemoryStream();
            await process.StandardOutput.BaseStream.CopyToAsync(buffer, timeout.Token);
            return buffer.ToArray();
        });
        var stderrTask = process.StandardError.ReadToEndAsync(timeout.Token);

        try
        {
            await process.StandardInput.BaseStream.WriteAsync(stdin, timeout.Token);
            await process.StandardInput.BaseStream.FlushAsync(timeout.Token);
        }
        catch (IOException)
        {
            // The host may exit before reading stdin (e.g. forbidden origin).
        }
        process.StandardInput.Close();

        await process.WaitForExitAsync(timeout.Token);
        return new ProcessRun(process.ExitCode, await stdoutTask, await stderrTask);
    }

    private static readonly string[] Chrome = [CallerOrigin.AllowedOrigin, "--parent-window=0"];

    [Fact]
    public async Task Ping_OverRealProcess()
    {
        var run = await RunAsync(Frames.Of(Frames.Request("ping", "p-1")), Chrome);

        Assert.Equal(ExitCodes.CleanEof, run.ExitCode);
        var response = Assert.Single(Frames.Parse(run.Stdout));
        Assert.Equal("p-1", response.GetProperty("requestId").GetString());
        Assert.Equal("pong", response.GetProperty("result").GetProperty("command").GetString());
    }

    [Fact]
    public async Task GetState_OverRealProcess_ReportsServiceUnavailable()
    {
        var run = await RunAsync(Frames.Of(Frames.Request("getState", "g-1")), Chrome);

        var response = Assert.Single(Frames.Parse(run.Stdout));
        Assert.Equal(ProtocolV1.Errors.ServiceUnavailable, response.GetProperty("error").GetProperty("code").GetString());
    }

    [Fact]
    public async Task SequentialAndMalformed_OverRealProcess_StdoutIsPure()
    {
        var run = await RunAsync(Frames.Concat(
            Frames.Of(Frames.Request("ping", "a")),
            Frames.Of("{broken"),
            Frames.Of(Frames.Request("getState", "b")),
            Frames.Of(Frames.Request("nope", "c"))), Chrome);

        Assert.Equal(ExitCodes.CleanEof, run.ExitCode);
        var responses = Frames.Parse(run.Stdout);
        Assert.Equal(4, responses.Count);
        Assert.Contains("[native-host]", run.Stderr, StringComparison.Ordinal);
        Assert.DoesNotContain("[native-host]", Encoding.UTF8.GetString(run.Stdout), StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("")]
    [InlineData("chrome-extension://onodojebmdbcndjelgfhoiffeojngmbd/")]
    [InlineData("chrome-extension://lfaekfalhkgmbfdjjlfcalanhijeaien/|--extra")]
    public async Task WrongOrigin_OverRealProcess_IsRejected(string args)
    {
        var run = await RunAsync(Frames.Of(Frames.Request("ping")), SecurityTests.Args(args));

        Assert.Equal(ExitCodes.ForbiddenOrigin, run.ExitCode);
        var response = Assert.Single(Frames.Parse(run.Stdout));
        Assert.Equal(ProtocolV1.Errors.ForbiddenOrigin, response.GetProperty("error").GetProperty("code").GetString());
    }

    [Fact]
    public async Task TruncatedInput_OverRealProcess_ExitsWithCode3()
    {
        var run = await RunAsync(Frames.Header(50).Concat(new byte[10]).ToArray(), Chrome);

        Assert.Equal(ExitCodes.TruncatedMessage, run.ExitCode);
        Assert.Empty(run.Stdout);
    }

    [Fact]
    public async Task Oversized_OverRealProcess_ExitsWithCode2()
    {
        var run = await RunAsync(Frames.Header(10 * 1024 * 1024), Chrome);

        Assert.Equal(ExitCodes.MessageTooLarge, run.ExitCode);
        Assert.Single(Frames.Parse(run.Stdout));
    }
}
