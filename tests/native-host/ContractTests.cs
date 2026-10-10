using System.Text.Json;
using VpnRoute.NativeHost.Protocol;
using VpnRoute.NativeHost.Tests.Support;

namespace VpnRoute.NativeHost.Tests;

public class ContractTests
{
    private static async Task<JsonElement> SendAsync(string json, Service.IServiceStateClient? client = null) =>
        Assert.Single((await HostHarness.RunAsync(Frames.Of(json), client)).Responses);

    [Fact]
    public async Task PingResponse_HasExactShape()
    {
        var response = await SendAsync(Frames.Request("ping", "ping-7"));

        Assert.Equal(["protocolVersion", "requestId", "ok", "result"], Frames.Keys(response));
        Assert.Equal(1, response.GetProperty("protocolVersion").GetInt32());
        Assert.Equal("ping-7", response.GetProperty("requestId").GetString());
        var result = response.GetProperty("result");
        Assert.Equal(["command", "host", "protocolVersion", "hostVersion"], Frames.Keys(result));
        Assert.Equal("pong", result.GetProperty("command").GetString());
        Assert.Equal("SelectiveVpnRouter.NativeHost", result.GetProperty("host").GetString());
        Assert.Equal(1, result.GetProperty("protocolVersion").GetInt32());
        string hostVersion = result.GetProperty("hostVersion").GetString()!;
        Assert.Matches(@"^\d+\.\d+\.\d+(\.\d+)?( RC\d+)?$", hostVersion);
        Assert.Contains("RC17", hostVersion, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ManifestResponse_HasExactShape()
    {
        var response = await SendAsync(Frames.Request("getStateManifest", "gs-1"), FakeServiceClient.Default());

        Assert.Equal(["protocolVersion", "requestId", "ok", "result"], Frames.Keys(response));
        Assert.Equal("gs-1", response.GetProperty("requestId").GetString());
        var result = response.GetProperty("result");
        Assert.Equal(["schemaVersion", "stateGeneration", "revision", "defaultRoute", "ruleCount", "pageBudgetBytes", "browserProxy"],
            Frames.Keys(result));
        var proxy = result.GetProperty("browserProxy");
        Assert.Equal(["status", "endpoint"], Frames.Keys(proxy));
        Assert.Equal("Unavailable", proxy.GetProperty("status").GetString());
        Assert.Equal(JsonValueKind.Null, proxy.GetProperty("endpoint").ValueKind);
    }

    [Fact]
    public async Task PageResponse_HasExactShape()
    {
        var response = await SendAsync(SampleService.PageRequest(0, "pg-1"), FakeServiceClient.Default());

        Assert.Equal(["protocolVersion", "requestId", "ok", "result"], Frames.Keys(response));
        Assert.Equal(["stateGeneration", "revision", "startIndex", "nextIndex", "rules"], Frames.Keys(response.GetProperty("result")));
    }

    [Fact]
    public async Task ErrorResponse_HasExactShape()
    {
        var response = await SendAsync(Frames.Request("getStateManifest", "e-1"));

        Assert.Equal(["protocolVersion", "requestId", "ok", "error"], Frames.Keys(response));
        Assert.Equal("e-1", response.GetProperty("requestId").GetString());
        Assert.Equal(["code", "message"], Frames.Keys(response.GetProperty("error")));
    }

    [Theory]
    [InlineData("550e8400-e29b-41d4-a716-446655440000")]
    [InlineData("a")]
    [InlineData("req:1.2_3-4")]
    public async Task RequestId_IsPreserved(string requestId)
    {
        var response = await SendAsync(Frames.Request("ping", requestId));

        Assert.Equal(requestId, response.GetProperty("requestId").GetString());
    }

    [Theory]
    [InlineData("""{"protocolVersion":1,"command":"ping"}""")]
    [InlineData("""{"protocolVersion":1,"requestId":"","command":"ping"}""")]
    [InlineData("""{"protocolVersion":1,"requestId":7,"command":"ping"}""")]
    [InlineData("""{"protocolVersion":1,"requestId":"has space","command":"ping"}""")]
    [InlineData("""{"protocolVersion":1,"requestId":"<script>","command":"ping"}""")]
    [InlineData("""{"protocolVersion":1,"requestId":"a\nb","command":"ping"}""")]
    [InlineData("""{"protocolVersion":1,"requestId":"x","requestId":"y","command":"ping"}""")]
    [InlineData("""{"protocolVersion":1,"requestId":"x","command":"ping","extra":true}""")]
    [InlineData("""[1,2]""")]
    [InlineData("""42""")]
    public async Task InvalidEnvelope_ReturnsInvalidRequest_WithNullRequestId(string json)
    {
        var response = await SendAsync(json);

        Assert.Equal(ProtocolV1.Errors.InvalidRequest, response.GetProperty("error").GetProperty("code").GetString());
        Assert.Equal(JsonValueKind.Null, response.GetProperty("requestId").ValueKind);
    }

    [Fact]
    public async Task OverlongRequestId_IsRejected()
    {
        var response = await SendAsync(Frames.Request("ping", new string('a', ProtocolV1.MaxRequestIdLength + 1)));

        Assert.Equal(ProtocolV1.Errors.InvalidRequest, response.GetProperty("error").GetProperty("code").GetString());
    }

    [Theory]
    [InlineData("""{"requestId":"r","command":"ping"}""")]
    [InlineData("""{"protocolVersion":"1","requestId":"r","command":"ping"}""")]
    [InlineData("""{"protocolVersion":1.5,"requestId":"r","command":"ping"}""")]
    [InlineData("""{"protocolVersion":1,"requestId":"r"}""")]
    [InlineData("""{"protocolVersion":1,"requestId":"r","command":null}""")]
    public async Task InvalidFields_KeepValidRequestId(string json)
    {
        var response = await SendAsync(json);

        Assert.Equal(ProtocolV1.Errors.InvalidRequest, response.GetProperty("error").GetProperty("code").GetString());
        Assert.Equal("r", response.GetProperty("requestId").GetString());
    }

    [Fact]
    public async Task ResponseProtocolVersion_IsAlwaysOne()
    {
        var response = await SendAsync(Frames.Request("ping", "pv", 2));

        Assert.Equal(1, response.GetProperty("protocolVersion").GetInt32());
    }

    [Fact]
    public void EveryErrorCode_HasFixedMessage()
    {
        foreach (var code in ResponseWriter.KnownErrorCodes)
        {
            using var document = JsonDocument.Parse(ResponseWriter.Error("x", code));
            var message = document.RootElement.GetProperty("error").GetProperty("message").GetString();
            Assert.False(string.IsNullOrWhiteSpace(message));
        }
    }
}
