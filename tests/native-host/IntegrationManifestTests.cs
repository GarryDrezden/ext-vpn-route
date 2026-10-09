using System.Text;
using System.Text.Json;
using VpnRoute.NativeHost.Protocol;
using VpnRoute.NativeHost.Service;
using VpnRoute.NativeHost.Tests.Support;

namespace VpnRoute.NativeHost.Tests;

public class IntegrationManifestTests
{
    private static async Task<(JsonElement Response, FakeServiceClient Client)> SendManifestAsync(string json, FakeServiceClient? client = null)
    {
        client ??= FakeServiceClient.Default();
        var response = Assert.Single((await HostHarness.RunAsync(Frames.Of(json), client)).Responses);
        return (response, client);
    }

    [Fact]
    public async Task LegacyGetStateManifest_WithoutClient_ForwardsPlainServiceRequest()
    {
        var (response, client) = await SendManifestAsync(Frames.Request("getStateManifest", "gs-legacy"));
        Assert.True(response.GetProperty("ok").GetBoolean());
        Assert.Null(client.LastManifestClient);
    }

    [Fact]
    public async Task HeartbeatGetStateManifest_ForwardsClientToService()
    {
        const string json = """{"protocolVersion":1,"requestId":"hb-1","command":"getStateManifest","client":{"extensionVersion":"0.1.0","nativeHostVersion":"0.5.0"}}""";
        var (response, client) = await SendManifestAsync(json);
        Assert.True(response.GetProperty("ok").GetBoolean());
        Assert.NotNull(client.LastManifestClient);
        Assert.Equal("0.1.0", client.LastManifestClient!.ExtensionVersion);
        Assert.Equal("0.5.0", client.LastManifestClient.NativeHostVersion);
    }

    [Fact]
    public async Task Host_DoesNotInjectClient_UnlessExtensionRequested()
    {
        var (_, client) = await SendManifestAsync(Frames.Request("getStateManifest", "gs-plain"));
        Assert.Null(client.LastManifestClient);
    }

    [Theory]
    [InlineData("""{"protocolVersion":1,"requestId":"x","command":"getStateManifest","client":{"extensionVersion":"","nativeHostVersion":"0.1.0"}}""")]
    [InlineData("""{"protocolVersion":1,"requestId":"x","command":"getStateManifest","client":{"extensionVersion":"0.1.0","nativeHostVersion":"0.1.0","extra":true}}""")]
    public async Task InvalidClientShape_IsRejected(string json)
    {
        var response = Assert.Single((await HostHarness.RunAsync(Frames.Of(json))).Responses);
        Assert.Equal(ProtocolV1.Errors.InvalidRequest, response.GetProperty("error").GetProperty("code").GetString());
    }

    [Fact]
    public async Task IntegrationManifest_WithAdditiveFields_IsRelayed()
    {
        var integrationManifest = SampleService.Manifest()[..^1] +
            ""","integrationApiVersion":1,"serviceVersion":"0.1.0","capabilities":["browserRoutingState"],"vpnEgress":{"status":"Unavailable","interfaceIndex":null,"interfaceName":null},"browserClient":{"status":"NeverSeen","lastSeenUtc":null}}""";
        var client = FakeServiceClient.Returning(ServiceReply.Success(Encoding.UTF8.GetBytes(integrationManifest)));
        var (response, _) = await SendManifestAsync(Frames.Request("getStateManifest", "gs-v1"), client);
        Assert.True(response.GetProperty("ok").GetBoolean());
        var result = response.GetProperty("result");
        Assert.Equal(1, result.GetProperty("integrationApiVersion").GetInt32());
    }

    /// <summary>
    /// Golden vector from live VPN Route Service after Browser Integration Port deploy (Slice 8).
    /// A stale Native Host build that predates v1 manifest allowlisting rejects this as invalid_service_response.
    /// </summary>
    [Fact]
    public async Task LiveDeployedServiceManifestShape_IsRelayed()
    {
        const string liveManifest =
            """{"schemaVersion":1,"stateGeneration":"75f5c435-6ac5-45a5-876b-042a6376635e","revision":0,"defaultRoute":"Direct","ruleCount":0,"pageBudgetBytes":520192,"integrationApiVersion":1,"serviceVersion":"0.2.0.0","capabilities":["browserClientHeartbeat","browserExplicitSocks","browserRoutingState","vpnEgressReadiness"],"browserProxy":{"status":"Ready","endpoint":{"host":"127.0.0.1","port":56030}},"vpnEgress":{"status":"Unavailable","interfaceIndex":null,"interfaceName":null},"browserClient":{"status":"NeverSeen","lastSeenUtc":null}}""";
        var client = FakeServiceClient.Returning(ServiceReply.Success(Encoding.UTF8.GetBytes(liveManifest)));
        var (response, _) = await SendManifestAsync(Frames.Request("getStateManifest", "slice8-live"), client);
        Assert.True(response.GetProperty("ok").GetBoolean());
        var result = response.GetProperty("result");
        Assert.Equal("Ready", result.GetProperty("browserProxy").GetProperty("status").GetString());
        Assert.Equal(56030, result.GetProperty("browserProxy").GetProperty("endpoint").GetProperty("port").GetInt32());
        Assert.Equal(1, result.GetProperty("integrationApiVersion").GetInt32());
    }
}
