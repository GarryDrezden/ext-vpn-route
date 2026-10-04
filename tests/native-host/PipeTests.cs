using System.Diagnostics;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using VpnRoute.NativeHost.Protocol;
using VpnRoute.NativeHost.Security;
using VpnRoute.NativeHost.Service;
using VpnRoute.NativeHost.Tests.Support;

namespace VpnRoute.NativeHost.Tests;

/// <summary>Production pipe client and the real host process against a real named pipe.</summary>
[Collection(ServicePipeCollection.Name)]
public class PipeTests
{
    private static readonly SnapshotIdentity Identity = new(SampleService.Generation, SampleService.Revision);

    private static Func<byte[], Task<byte[]?>> Answer(Func<string, string> json) =>
        request => Task.FromResult<byte[]?>(FakeServicePipe.Frame(json(FakeServicePipe.RequestId(request))));

    [Fact]
    public async Task Client_SendsExactRequests_WithIdentificationLevel()
    {
        await using var server = new FakeServicePipe(request =>
        {
            var id = FakeServicePipe.RequestId(request);
            var method = JsonDocument.Parse(request).RootElement.GetProperty("method").GetString();
            return Task.FromResult<byte[]?>(FakeServicePipe.Frame(method == "getManifest"
                ? FakeServicePipe.Ok(id, SampleService.Manifest())
                : FakeServicePipe.Ok(id, SampleService.Page(7, 1, null))));
        });
        var client = new BrowserRoutingPipeClient(server.Name);

        var manifest = await client.GetManifestAsync("m-1", CancellationToken.None);
        var page = await client.GetPageAsync("p-1", Identity, 7, CancellationToken.None);

        Assert.Equal(SampleService.Manifest(), Encoding.UTF8.GetString(manifest.Result!));
        Assert.Equal(SampleService.Page(7, 1, null), Encoding.UTF8.GetString(page.Result!));
        Assert.Equal("""{"version":1,"id":"m-1","method":"getManifest"}""", Encoding.UTF8.GetString(server.Requests[0]));
        Assert.Equal(
            $$$"""{"version":1,"id":"p-1","method":"getPage","params":{"stateGeneration":"{{{SampleService.Generation}}}","revision":43,"startIndex":7}}""",
            Encoding.UTF8.GetString(server.Requests[1]));
        Assert.All(server.ClientLevels, level => Assert.Equal(TokenImpersonationLevel.Identification, level));
    }

    [Fact]
    public async Task Client_ForwardsServiceErrorCode()
    {
        await using var server = new FakeServicePipe(Answer(id => FakeServicePipe.Error(id, "snapshot_changed")));
        var reply = await new BrowserRoutingPipeClient(server.Name).GetPageAsync("p-1", Identity, 0, CancellationToken.None);
        Assert.Equal("snapshot_changed", reply.ErrorCode);
    }

    public static TheoryData<string> BrokenResponses => new() { "garbage", "early-eof", "huge-header", "zero-length", "partial-body", "wrong-id" };

    [Theory]
    [MemberData(nameof(BrokenResponses))]
    public async Task Client_RejectsBrokenResponses(string kind)
    {
        await using var server = new FakeServicePipe(request => Task.FromResult(kind switch
        {
            "garbage" => FakeServicePipe.Frame("not json at all"),
            "early-eof" => null,
            "huge-header" => [0xFF, 0xFF, 0xFF, 0x7F],
            "zero-length" => [0, 0, 0, 0],
            "partial-body" => FakeServicePipe.Frame(FakeServicePipe.Ok(FakeServicePipe.RequestId(request), "{}"))[..20],
            _ => FakeServicePipe.Frame(FakeServicePipe.Ok("someone-else", SampleService.Manifest()))
        }));
        await Assert.ThrowsAsync<InvalidServiceResponseException>(
            () => new BrowserRoutingPipeClient(server.Name).GetManifestAsync("m-1", CancellationToken.None));
    }

    [Fact]
    public async Task Client_WithoutServer_IsUnavailableQuickly()
    {
        var watch = Stopwatch.StartNew();
        await Assert.ThrowsAsync<ServiceUnavailableException>(
            () => new BrowserRoutingPipeClient(FakeServicePipe.NewTestPipeName()).GetManifestAsync("m-1", CancellationToken.None));
        Assert.True(watch.Elapsed < TimeSpan.FromSeconds(3), watch.Elapsed.ToString());
    }

    [Fact]
    public async Task Client_WithRejectedPipeName_NeverConnects()
    {
        await Assert.ThrowsAsync<ServiceUnavailableException>(
            () => new BrowserRoutingPipeClient(null).GetManifestAsync("m-1", CancellationToken.None));
    }

    [Fact]
    public void PipeName_DefaultsToProduction_AndAcceptsOnlyTestNamespaceOverrides()
    {
        Assert.Equal("SelectiveVpnRouter.BrowserRouting", ServiceIpcV1.PipeName);
        Assert.Equal(ServiceIpcV1.PipeName, ServiceIpcV1.ResolvePipeName(null));
        Assert.Equal(ServiceIpcV1.PipeName, ServiceIpcV1.ResolvePipeName(""));
        var valid = FakeServicePipe.NewTestPipeName();
        Assert.Equal(valid, ServiceIpcV1.ResolvePipeName(valid));
        foreach (var bad in new[]
                 {
                     "SelectiveVpnRouter", ServiceIpcV1.PipeName, ServiceIpcV1.PipeName + ".Test.",
                     valid.ToUpperInvariant(), valid + "0", valid[..^1], valid[..^1] + "g",
                     @"\\.\pipe\" + valid, valid.Replace(".Test.", ".test."), "other.Test." + new string('a', 32)
                 })
        {
            Assert.Null(ServiceIpcV1.ResolvePipeName(bad));
        }
    }

    [Fact]
    public void OwnerTrust_AllowsOnlySystemAdministratorsAndCurrentUser()
    {
        var current = WindowsIdentity.GetCurrent().User!;
        Assert.True(BrowserRoutingPipeClient.IsTrustedOwner(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), current));
        Assert.True(BrowserRoutingPipeClient.IsTrustedOwner(new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null), current));
        Assert.True(BrowserRoutingPipeClient.IsTrustedOwner(current, current));
        Assert.False(BrowserRoutingPipeClient.IsTrustedOwner(new SecurityIdentifier("S-1-5-21-1000000000-2000000000-3000000000-1001"), current));
        Assert.False(BrowserRoutingPipeClient.IsTrustedOwner(new SecurityIdentifier(WellKnownSidType.WorldSid, null), current));
        Assert.False(BrowserRoutingPipeClient.IsTrustedOwner(new SecurityIdentifier(WellKnownSidType.InteractiveSid, null), current));
        Assert.False(BrowserRoutingPipeClient.IsTrustedOwner(new SecurityIdentifier(WellKnownSidType.BuiltinUsersSid, null), current));
        Assert.False(BrowserRoutingPipeClient.IsTrustedOwner(null, current));
    }

    [Fact]
    public async Task RealHost_RelaysManifestAndPage_OverRealPipe()
    {
        await using var server = new FakeServicePipe(request =>
        {
            var id = FakeServicePipe.RequestId(request);
            var method = JsonDocument.Parse(request).RootElement.GetProperty("method").GetString();
            return Task.FromResult<byte[]?>(FakeServicePipe.Frame(method == "getManifest"
                ? FakeServicePipe.Ok(id, SampleService.Manifest(ruleCount: 2))
                : FakeServicePipe.Ok(id, SampleService.Page(0, 2, null))));
        });

        var run = await HostProcess.RunAsync(Frames.Concat(
            Frames.Of(Frames.Request("getStateManifest", "rm-1")),
            Frames.Of(SampleService.PageRequest(0, "rp-1"))), HostProcess.Chrome, server.Name);

        Assert.Equal(ExitCodes.CleanEof, run.ExitCode);
        var responses = Frames.Parse(run.Stdout);
        Assert.Equal(2, responses.Count);
        Assert.Equal(SampleService.Manifest(ruleCount: 2), responses[0].GetProperty("result").GetRawText());
        Assert.Equal(SampleService.Page(0, 2, null), responses[1].GetProperty("result").GetRawText());
        Assert.Equal(["rm-1", "rp-1"], server.Requests.Select(FakeServicePipe.RequestId));
        Assert.DoesNotContain("host-00000", run.Stderr, StringComparison.Ordinal);
    }

    [Fact]
    public async Task RealHost_ServiceThatNeverAnswers_TimesOut()
    {
        await using var server = new FakeServicePipe(async _ =>
        {
            await Task.Delay(TimeSpan.FromSeconds(10));
            return null;
        });
        var watch = Stopwatch.StartNew();
        var run = await HostProcess.RunAsync(Frames.Of(Frames.Request("getStateManifest", "t-1")), HostProcess.Chrome, server.Name);

        var response = Assert.Single(Frames.Parse(run.Stdout));
        Assert.Equal(ProtocolV1.Errors.ServiceTimeout, response.GetProperty("error").GetProperty("code").GetString());
        Assert.True(watch.Elapsed < TimeSpan.FromSeconds(8), watch.Elapsed.ToString());
    }

    [Fact]
    public async Task RealHost_WithoutService_ReportsServiceUnavailable()
    {
        var run = await HostProcess.RunAsync(
            Frames.Of(Frames.Request("getStateManifest", "g-1")), HostProcess.Chrome, FakeServicePipe.NewTestPipeName());

        var response = Assert.Single(Frames.Parse(run.Stdout));
        Assert.Equal(ProtocolV1.Errors.ServiceUnavailable, response.GetProperty("error").GetProperty("code").GetString());
    }

    [Fact]
    public async Task RealHost_RejectedPipeOverride_NeverConnects()
    {
        await using var server = new FakeServicePipe(Answer(id => FakeServicePipe.Ok(id, SampleService.Manifest())));
        var run = await HostProcess.RunAsync(
            Frames.Of(Frames.Request("getStateManifest", "o-1")), HostProcess.Chrome, server.Name.ToUpperInvariant());

        var response = Assert.Single(Frames.Parse(run.Stdout));
        Assert.Equal(ProtocolV1.Errors.ServiceUnavailable, response.GetProperty("error").GetProperty("code").GetString());
        Assert.Empty(server.Requests);
        Assert.Contains("override rejected", run.Stderr, StringComparison.Ordinal);
    }

    [Fact]
    public async Task RealHost_ForbiddenOrigin_NeverConnectsToService()
    {
        await using var server = new FakeServicePipe(Answer(id => FakeServicePipe.Ok(id, SampleService.Manifest())));
        var run = await HostProcess.RunAsync(
            Frames.Of(Frames.Request("getStateManifest")), ["chrome-extension://onodojebmdbcndjelgfhoiffeojngmbd/"], server.Name);

        Assert.Equal(ExitCodes.ForbiddenOrigin, run.ExitCode);
        Assert.Empty(server.Requests);
    }
}

internal static class HostProcess
{
    public sealed record Run(int ExitCode, byte[] Stdout, string Stderr);

    public static readonly string[] Chrome = [CallerOrigin.AllowedOrigin, "--parent-window=0"];

    public static string Executable()
    {
        var configured = Environment.GetEnvironmentVariable("NATIVE_HOST_EXE");
        var path = string.IsNullOrEmpty(configured)
            ? Path.Combine(AppContext.BaseDirectory, "SelectiveVpnRouter.NativeHost.exe")
            : configured;
        Assert.True(File.Exists(path), $"host executable not found: {path}");
        return path;
    }

    public static async Task<Run> RunAsync(byte[] stdin, string[] args, string servicePipe)
    {
        var info = new ProcessStartInfo(Executable())
        {
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true
        };
        info.Environment[ServiceIpcV1.TestPipeVariable] = servicePipe;
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
        return new Run(process.ExitCode, await stdoutTask, await stderrTask);
    }
}
