using System.Text;
using System.Text.Json;
using VpnRoute.NativeHost.Protocol;
using VpnRoute.NativeHost.Service;
using VpnRoute.NativeHost.Tests.Support;

namespace VpnRoute.NativeHost.Tests;

public class ServiceTests
{
    private static async Task<(JsonElement Response, HostRun Run)> SendAsync(string request, IServiceStateClient client, TimeSpan? timeout = null)
    {
        var run = await HostHarness.RunAsync(Frames.Of(request), client, serviceTimeout: timeout);
        Assert.Equal(ExitCodes.CleanEof, run.ExitCode);
        return (Assert.Single(run.Responses), run);
    }

    private static string? ErrorCode(JsonElement response) =>
        response.GetProperty("ok").GetBoolean() ? null : response.GetProperty("error").GetProperty("code").GetString();

    private static string Manifest(string id = "m-1") => Frames.Request("getStateManifest", id);

    [Fact]
    public async Task Manifest_IsRelayedByteForByte()
    {
        var manifest = SampleService.Manifest(ruleCount: 2500);
        var client = FakeServiceClient.Returning(ServiceReply.Success(Encoding.UTF8.GetBytes(manifest)));
        var (response, run) = await SendAsync(Manifest("m-7"), client);

        Assert.Null(ErrorCode(response));
        Assert.Equal(manifest, response.GetProperty("result").GetRawText());
        Assert.Contains(manifest, Encoding.UTF8.GetString(run.Stdout), StringComparison.Ordinal);
        Assert.Equal("m-7", Assert.Single(client.Requests).CorrelationId);
    }

    [Fact]
    public async Task Page_IsRelayedWithoutReencoding()
    {
        const string page = """{"stateGeneration":"9b2f6c1e-1d2a-4f57-9a43-3f2a9d7c1b10","revision":43,"startIndex":0,"nextIndex":null,"rules":[{"id":"a","name":"\u0416 <b> & \u2014","host":"a.example","matchType":"ExactHost","routeMode":"VPN","enabled":true,"source":"User","notes":"x\ny"}]}""";
        var client = FakeServiceClient.Returning(SampleService.ManifestReply(), (_, _) => ServiceReply.Success(Encoding.UTF8.GetBytes(page)));
        var (response, run) = await SendAsync(SampleService.PageRequest(0, "p-1"), client);

        Assert.Null(ErrorCode(response));
        Assert.Contains(page, Encoding.UTF8.GetString(run.Stdout), StringComparison.Ordinal);
        var call = Assert.Single(client.Requests);
        Assert.Equal("p-1", call.CorrelationId);
        Assert.Equal(new SnapshotIdentity(SampleService.Generation, 43), call.Identity);
        Assert.Equal(0, call.StartIndex);
    }

    [Theory]
    [InlineData("""{"protocolVersion":1,"requestId":"r","command":"getStatePage","revision":43,"startIndex":0}""")]
    [InlineData("""{"protocolVersion":1,"requestId":"r","command":"getStatePage","stateGeneration":"G","startIndex":0}""")]
    [InlineData("""{"protocolVersion":1,"requestId":"r","command":"getStatePage","stateGeneration":"G","revision":43}""")]
    [InlineData("""{"protocolVersion":1,"requestId":"r","command":"getStatePage","stateGeneration":"9B2F6C1E-1D2A-4F57-9A43-3F2A9D7C1B10","revision":43,"startIndex":0}""")]
    [InlineData("""{"protocolVersion":1,"requestId":"r","command":"getStatePage","stateGeneration":"..\\..\\state","revision":43,"startIndex":0}""")]
    [InlineData("""{"protocolVersion":1,"requestId":"r","command":"getStatePage","stateGeneration":"G","revision":-1,"startIndex":0}""")]
    [InlineData("""{"protocolVersion":1,"requestId":"r","command":"getStatePage","stateGeneration":"G","revision":9007199254740992,"startIndex":0}""")]
    [InlineData("""{"protocolVersion":1,"requestId":"r","command":"getStatePage","stateGeneration":"G","revision":43.5,"startIndex":0}""")]
    [InlineData("""{"protocolVersion":1,"requestId":"r","command":"getStatePage","stateGeneration":"G","revision":43,"startIndex":-1}""")]
    [InlineData("""{"protocolVersion":1,"requestId":"r","command":"getStatePage","stateGeneration":"G","revision":43,"startIndex":10001}""")]
    [InlineData("""{"protocolVersion":1,"requestId":"r","command":"getStatePage","stateGeneration":"G","revision":43,"startIndex":"0"}""")]
    [InlineData("""{"protocolVersion":1,"requestId":"r","command":"getStatePage","stateGeneration":"G","revision":43,"startIndex":1.5}""")]
    [InlineData("""{"protocolVersion":1,"requestId":"r","command":"getStateManifest","startIndex":0}""")]
    [InlineData("""{"protocolVersion":1,"requestId":"r","command":"ping","revision":1}""")]
    public async Task InvalidStateRequest_IsRejected_WithoutCallingService(string json)
    {
        var client = FakeServiceClient.Default();
        var (response, _) = await SendAsync(json.Replace("\"G\"", "\"" + SampleService.Generation + "\""), client);

        Assert.Equal(ProtocolV1.Errors.InvalidRequest, ErrorCode(response));
        Assert.Equal("r", response.GetProperty("requestId").GetString());
        Assert.Equal(0, client.Calls);
    }

    [Fact]
    public async Task UnknownPageField_IsRejected_BeforeTheRequestIsTrusted()
    {
        var client = FakeServiceClient.Default();
        var json = $$$"""{"protocolVersion":1,"requestId":"r","command":"getStatePage","stateGeneration":"{{{SampleService.Generation}}}","revision":43,"startIndex":0,"cursor":"../x"}""";
        var (response, _) = await SendAsync(json, client);

        Assert.Equal(ProtocolV1.Errors.InvalidRequest, ErrorCode(response));
        Assert.Equal(JsonValueKind.Null, response.GetProperty("requestId").ValueKind);
        Assert.Equal(0, client.Calls);
    }

    [Theory]
    [InlineData("snapshot_changed", "snapshot_changed")]
    [InlineData("invalid_cursor", "invalid_cursor")]
    [InlineData("browser_state_unavailable", "browser_state_unavailable")]
    [InlineData("internal_error", "service_error")]
    [InlineData("unknown_method", "service_error")]
    [InlineData("evil_reflected_marker", "service_error")]
    public async Task ServiceErrorCodes_AreForwardedOnlyFromTheAllowlist(string serviceCode, string expected)
    {
        var client = FakeServiceClient.Returning(ServiceReply.Failure(serviceCode), (_, _) => ServiceReply.Failure(serviceCode));
        var (manifest, run) = await SendAsync(Manifest(), client);
        var (page, _) = await SendAsync(SampleService.PageRequest(), client);

        Assert.Equal(expected, ErrorCode(manifest));
        Assert.Equal(expected, ErrorCode(page));
        Assert.DoesNotContain("evil", manifest.GetRawText(), StringComparison.Ordinal);
        Assert.DoesNotContain(run.Log, line => line.Contains("evil", StringComparison.Ordinal));
    }

    public static TheoryData<string, string> Exceptions => new()
    {
        { "unavailable", ProtocolV1.Errors.ServiceUnavailable },
        { "untrusted", ProtocolV1.Errors.ServiceUntrusted },
        { "invalid", ProtocolV1.Errors.InvalidServiceResponse },
        { "timeout", ProtocolV1.Errors.ServiceTimeout },
        { "other", ProtocolV1.Errors.ServiceError }
    };

    [Theory]
    [MemberData(nameof(Exceptions))]
    public async Task ClientExceptions_MapToFixedCodes(string kind, string expected)
    {
        Exception exception = kind switch
        {
            "unavailable" => new ServiceUnavailableException(),
            "untrusted" => new ServiceUntrustedException(),
            "invalid" => new InvalidServiceResponseException(),
            "timeout" => new TimeoutException(),
            _ => new InvalidOperationException("SECRET \\\\.\\pipe\\x C:\\Users\\someone")
        };
        var client = FakeServiceClient.Throwing(exception);
        var (manifest, run) = await SendAsync(Manifest(), client);
        var (page, _) = await SendAsync(SampleService.PageRequest(), client);

        Assert.Equal(expected, ErrorCode(manifest));
        Assert.Equal(expected, ErrorCode(page));
        Assert.DoesNotContain("SECRET", manifest.GetRawText(), StringComparison.Ordinal);
        Assert.DoesNotContain(run.Log, line => line.Contains("SECRET", StringComparison.Ordinal));
    }

    [Fact]
    public async Task SynchronousThrow_IsMappedToServiceError()
    {
        var client = new FakeServiceClient(_ => throw new IOException("boom"), (_, _, _) => throw new IOException("boom"));
        Assert.Equal(ProtocolV1.Errors.ServiceError, ErrorCode((await SendAsync(Manifest(), client)).Response));
    }

    [Fact]
    public async Task SlowService_TimesOut()
    {
        var client = new FakeServiceClient(async ct =>
        {
            await Task.Delay(Timeout.Infinite, ct);
            return SampleService.ManifestReply();
        }, (_, _, _) => throw new InvalidOperationException());

        Assert.Equal(ProtocolV1.Errors.ServiceTimeout, ErrorCode((await SendAsync(Manifest(), client, TimeSpan.FromMilliseconds(100))).Response));
    }

    [Fact]
    public async Task ServiceIgnoringCancellation_StillTimesOut()
    {
        var never = new TaskCompletionSource<ServiceReply>();
        var client = new FakeServiceClient(_ => never.Task, (_, _, _) => never.Task);

        Assert.Equal(ProtocolV1.Errors.ServiceTimeout, ErrorCode((await SendAsync(Manifest(), client, TimeSpan.FromMilliseconds(100))).Response));
        Assert.Equal(ProtocolV1.Errors.ServiceTimeout,
            ErrorCode((await SendAsync(SampleService.PageRequest(), client, TimeSpan.FromMilliseconds(100))).Response));
    }

    [Theory]
    [InlineData("""{"status":"Ready","endpoint":{"host":"0.0.0.0","port":1080}}""")]
    [InlineData("""{"status":"Ready","endpoint":{"host":"192.168.1.10","port":1080}}""")]
    [InlineData("""{"status":"Ready","endpoint":{"host":"localhost","port":1080}}""")]
    [InlineData("""{"status":"Ready","endpoint":{"host":"127.0.0.01","port":1080}}""")]
    [InlineData("""{"status":"Ready","endpoint":{"host":"::1","port":1080}}""")]
    [InlineData("""{"status":"Ready","endpoint":{"host":"127.0.0.1","port":0}}""")]
    [InlineData("""{"status":"Ready","endpoint":{"host":"127.0.0.1","port":65536}}""")]
    [InlineData("""{"status":"Ready","endpoint":null}""")]
    [InlineData("""{"status":"Unavailable","endpoint":{"host":"127.0.0.1","port":17891}}""")]
    [InlineData("""{"status":"Starting","endpoint":null}""")]
    [InlineData("""{"status":"Unavailable"}""")]
    [InlineData("""null""")]
    public async Task ManifestWithInvalidProxyReadiness_IsRejected(string proxy)
    {
        var client = FakeServiceClient.Returning(SampleService.ManifestReply(proxy: proxy));
        Assert.Equal(ProtocolV1.Errors.InvalidServiceResponse, ErrorCode((await SendAsync(Manifest(), client)).Response));
    }

    [Fact]
    public async Task ManifestWithReadyLoopbackProxy_IsRelayed()
    {
        var client = FakeServiceClient.Returning(SampleService.ManifestReply(proxy: """{"status":"Ready","endpoint":{"host":"127.0.0.1","port":18080}}"""));
        var (response, _) = await SendAsync(Manifest(), client);
        Assert.Equal(18080, response.GetProperty("result").GetProperty("browserProxy").GetProperty("endpoint").GetProperty("port").GetInt32());
    }

    [Theory]
    [InlineData("""{"schemaVersion":1,"stateGeneration":"G","revision":43,"defaultRoute":"Direct","ruleCount":1,"pageBudgetBytes":520192}""")]
    [InlineData("""{"schemaVersion":1,"stateGeneration":"G","revision":43,"defaultRoute":"Direct","ruleCount":1,"pageBudgetBytes":520192,"browserProxy":{"status":"Unavailable","endpoint":null},"rules":[]}""")]
    [InlineData("""{"schemaVersion":1,"stateGeneration":"not-a-generation","revision":43,"defaultRoute":"Direct","ruleCount":1,"pageBudgetBytes":520192,"browserProxy":{"status":"Unavailable","endpoint":null}}""")]
    [InlineData("""{"schemaVersion":1,"stateGeneration":"G","revision":-1,"defaultRoute":"Direct","ruleCount":1,"pageBudgetBytes":520192,"browserProxy":{"status":"Unavailable","endpoint":null}}""")]
    [InlineData("""{"schemaVersion":1,"stateGeneration":"G","revision":43,"defaultRoute":"Direct","ruleCount":10001,"pageBudgetBytes":520192,"browserProxy":{"status":"Unavailable","endpoint":null}}""")]
    [InlineData("""{"schemaVersion":1,"stateGeneration":"G","revision":43,"defaultRoute":"Direct","ruleCount":1,"pageBudgetBytes":2000000,"browserProxy":{"status":"Unavailable","endpoint":null}}""")]
    [InlineData("""[1]""")]
    public async Task MalformedManifest_IsRejected(string manifest)
    {
        var bytes = Encoding.UTF8.GetBytes(manifest.Replace("\"G\"", "\"" + SampleService.Generation + "\""));
        var client = FakeServiceClient.Returning(ServiceReply.Success(bytes));
        Assert.Equal(ProtocolV1.Errors.InvalidServiceResponse, ErrorCode((await SendAsync(Manifest(), client)).Response));
    }

    public static TheoryData<string> BadPages => new()
    {
        SampleService.Page(0, 1, null, revision: 44),
        SampleService.Page(0, 1, null, generation: "00000000-0000-4000-8000-000000000000"),
        SampleService.Page(5, 1, null),
        SampleService.Page(0, 0, null),
        SampleService.Page(0, 2, 3),
        SampleService.Page(0, 2, 1),
        """{"stateGeneration":"9b2f6c1e-1d2a-4f57-9a43-3f2a9d7c1b10","revision":43,"startIndex":0,"nextIndex":null,"rules":{}}""",
        """{"stateGeneration":"9b2f6c1e-1d2a-4f57-9a43-3f2a9d7c1b10","revision":43,"startIndex":0,"rules":[{}]}""",
        """{"stateGeneration":"9b2f6c1e-1d2a-4f57-9a43-3f2a9d7c1b10","revision":43,"startIndex":0,"nextIndex":null,"rules":[{}],"extra":1}"""
    };

    [Theory]
    [MemberData(nameof(BadPages))]
    public async Task InconsistentPage_IsRejected(string page)
    {
        var client = FakeServiceClient.Returning(SampleService.ManifestReply(), (_, _) => ServiceReply.Success(Encoding.UTF8.GetBytes(page)));
        Assert.Equal(ProtocolV1.Errors.InvalidServiceResponse, ErrorCode((await SendAsync(SampleService.PageRequest(), client)).Response));
    }

    [Fact]
    public async Task OversizedServiceResult_IsRejected()
    {
        var huge = SampleService.Page(0, 3000, null);
        Assert.True(huge.Length > ServiceIpcV1.MaxResponseBytes);
        var client = FakeServiceClient.Returning(SampleService.ManifestReply(), (_, _) => ServiceReply.Success(Encoding.UTF8.GetBytes(huge)));
        Assert.Equal(ProtocolV1.Errors.InvalidServiceResponse, ErrorCode((await SendAsync(SampleService.PageRequest(), client)).Response));
    }

    [Fact]
    public async Task PageNearServiceLimit_StaysWellBelowChromiumLimit()
    {
        var page = SampleService.Page(0, 2500, 2500);
        Assert.InRange(page.Length, 400_000, ServiceIpcV1.MaxResponseBytes);
        var client = FakeServiceClient.Returning(SampleService.ManifestReply(5000), (_, _) => ServiceReply.Success(Encoding.UTF8.GetBytes(page)));
        var (response, run) = await SendAsync(SampleService.PageRequest(), client);

        Assert.Null(ErrorCode(response));
        Assert.True(run.Stdout.Length - 4 < ProtocolV1.MaxResponseBytes);
        Assert.True(run.Stdout.Length - 4 - page.Length < 200);
    }

    [Fact]
    public async Task Ping_DoesNotCallService()
    {
        var client = FakeServiceClient.Throwing(new InvalidOperationException());
        var run = await HostHarness.RunAsync(Frames.Of(Frames.Request("ping")), client);

        Assert.True(Assert.Single(run.Responses).GetProperty("ok").GetBoolean());
        Assert.Equal(0, client.Calls);
    }

    [Fact]
    public async Task EveryStateRequest_CallsServiceAgain_NoCaching()
    {
        var client = FakeServiceClient.Default();
        await HostHarness.RunAsync(Frames.Concat(
            Frames.Of(Manifest("c1")), Frames.Of(Manifest("c2")),
            Frames.Of(SampleService.PageRequest(0, "c3")), Frames.Of(SampleService.PageRequest(0, "c4"))), client);

        Assert.Equal(["c1", "c2", "c3", "c4"], client.Requests.Select(r => r.CorrelationId));
    }

    [Fact]
    public async Task LegacyGetState_IsNoLongerACommand()
    {
        var client = FakeServiceClient.Default();
        var (response, _) = await SendAsync(Frames.Request("getState"), client);
        Assert.Equal(ProtocolV1.Errors.UnknownCommand, ErrorCode(response));
        Assert.Equal(0, client.Calls);
    }
}

public class ServiceResponseParsingTests
{
    private static ServiceReply Parse(string json, string id = "c-1") =>
        BrowserRoutingPipeClient.ParseResponse(Encoding.UTF8.GetBytes(json), id);

    [Fact]
    public void Success_ReturnsRawResultBytes()
    {
        var reply = Parse("""{"version":1,"id":"c-1","ok":true,"result":{"a":"\u0416","b":[1, 2]}}""");
        Assert.Null(reply.ErrorCode);
        Assert.Equal("""{"a":"\u0416","b":[1, 2]}""", Encoding.UTF8.GetString(reply.Result!));
    }

    [Theory]
    [InlineData("""{"version":1,"id":"c-1","ok":false,"error":{"code":"snapshot_changed"}}""")]
    [InlineData("""{"version":1,"id":null,"ok":false,"error":{"code":"snapshot_changed"}}""")]
    public void Error_ReturnsCode(string json) => Assert.Equal("snapshot_changed", Parse(json).ErrorCode);

    [Theory]
    [InlineData("""{"version":1,"id":"other","ok":true,"result":{}}""")]
    [InlineData("""{"version":1,"id":null,"ok":true,"result":{}}""")]
    [InlineData("""{"version":1,"id":"other","ok":false,"error":{"code":"x"}}""")]
    [InlineData("""{"version":2,"id":"c-1","ok":true,"result":{}}""")]
    [InlineData("""{"id":"c-1","ok":true,"result":{}}""")]
    [InlineData("""{"version":1,"id":"c-1","ok":true,"result":[]}""")]
    [InlineData("""{"version":1,"id":"c-1","ok":true,"result":{},"extra":1}""")]
    [InlineData("""{"version":1,"id":"c-1","ok":"true","result":{}}""")]
    [InlineData("""{"version":1,"id":"c-1","ok":false,"error":{"code":"x","message":"leak"}}""")]
    [InlineData("""{"version":1,"id":"c-1","ok":false,"error":{"code":7}}""")]
    [InlineData("""{"version":1,"id":"c-1","ok":false,"result":{}}""")]
    [InlineData("""{"version":1,"id":"c-1","ok":true,"result":{}""")]
    [InlineData("""[]""")]
    public void MalformedEnvelope_IsInvalid(string json) =>
        Assert.Throws<InvalidServiceResponseException>(() => Parse(json));
}
