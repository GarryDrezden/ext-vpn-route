using System.Text.Json;
using VpnRoute.NativeHost.Protocol;
using VpnRoute.NativeHost.Service;
using VpnRoute.NativeHost.Tests.Support;

namespace VpnRoute.NativeHost.Tests;

public class ServiceTests
{
    private static async Task<JsonElement> GetStateAsync(IServiceStateClient client, TimeSpan? timeout = null)
    {
        var run = await HostHarness.RunAsync(Frames.Of(Frames.Request("getState")), client, serviceTimeout: timeout);
        Assert.Equal(ExitCodes.CleanEof, run.ExitCode);
        return Assert.Single(run.Responses);
    }

    private static string ErrorCode(JsonElement response)
    {
        Assert.False(response.GetProperty("ok").GetBoolean());
        return response.GetProperty("error").GetProperty("code").GetString()!;
    }

    [Fact]
    public async Task FakeService_StateIsForwardedVerbatim()
    {
        var response = await GetStateAsync(FakeServiceClient.Returning(SampleState.Snapshot()));

        var state = response.GetProperty("result").GetProperty("state");
        Assert.True(JsonElement.DeepEquals(SampleState.Element(), state));
    }

    [Fact]
    public async Task ProductionClient_ReportsServiceUnavailable()
    {
        var response = await GetStateAsync(new UnavailableServiceStateClient());

        Assert.Equal(ProtocolV1.Errors.ServiceUnavailable, ErrorCode(response));
    }

    [Fact]
    public async Task ProductionClient_ThrowsServiceUnavailable()
    {
        await Assert.ThrowsAsync<ServiceUnavailableException>(
            () => new UnavailableServiceStateClient().GetStateAsync(CancellationToken.None));
    }

    [Fact]
    public async Task ServiceException_IsMappedToSafeError_WithoutLeakingDetails()
    {
        var secret = "SECRET-PIPE-NAME \\\\.\\pipe\\vpnroute C:\\Users\\someone";
        var run = await HostHarness.RunAsync(
            Frames.Of(Frames.Request("getState")),
            FakeServiceClient.Throwing(new InvalidOperationException(secret)));

        var response = Assert.Single(run.Responses);
        Assert.Equal(ProtocolV1.Errors.ServiceError, ErrorCode(response));
        var raw = response.GetRawText();
        Assert.DoesNotContain("SECRET", raw, StringComparison.Ordinal);
        Assert.DoesNotContain("InvalidOperationException", raw, StringComparison.Ordinal);
        Assert.DoesNotContain(" at ", raw, StringComparison.Ordinal);
        Assert.DoesNotContain(run.Log, line => line.Contains("SECRET", StringComparison.Ordinal));
    }

    [Fact]
    public async Task SynchronousThrow_IsMappedToServiceError()
    {
        var client = new FakeServiceClient(_ => throw new IOException("boom"));

        Assert.Equal(ProtocolV1.Errors.ServiceError, ErrorCode(await GetStateAsync(client)));
    }

    [Fact]
    public async Task SlowService_TimesOut()
    {
        var client = new FakeServiceClient(async ct =>
        {
            await Task.Delay(Timeout.Infinite, ct);
            return SampleState.Snapshot();
        });

        Assert.Equal(ProtocolV1.Errors.ServiceTimeout, ErrorCode(await GetStateAsync(client, TimeSpan.FromMilliseconds(100))));
    }

    [Fact]
    public async Task ServiceIgnoringCancellation_StillTimesOut()
    {
        var never = new TaskCompletionSource<ServiceStateSnapshot>();
        var client = new FakeServiceClient(_ => never.Task);

        Assert.Equal(ProtocolV1.Errors.ServiceTimeout, ErrorCode(await GetStateAsync(client, TimeSpan.FromMilliseconds(100))));
    }

    [Theory]
    [InlineData("0.0.0.0", 17891)]
    [InlineData("192.168.1.10", 17891)]
    [InlineData("localhost", 17891)]
    [InlineData("127.0.0.01", 17891)]
    [InlineData("127.0.0", 17891)]
    [InlineData("::1", 17891)]
    [InlineData("127.0.0.1", 0)]
    [InlineData("127.0.0.1", 65536)]
    public async Task NonLoopbackOrInvalidEndpoint_IsRejected(string host, int port)
    {
        var response = await GetStateAsync(FakeServiceClient.Returning(SampleState.Snapshot(host, port)));

        Assert.Equal(ProtocolV1.Errors.InvalidServiceResponse, ErrorCode(response));
    }

    [Theory]
    [InlineData("[]")]
    [InlineData("null")]
    [InlineData("\"state\"")]
    public async Task NonObjectState_IsRejected(string json)
    {
        var snapshot = new ServiceStateSnapshot(SampleState.Element(json), new ProxyEndpoint("127.0.0.1", 17891));

        Assert.Equal(ProtocolV1.Errors.InvalidServiceResponse, ErrorCode(await GetStateAsync(FakeServiceClient.Returning(snapshot))));
    }

    [Fact]
    public async Task NullSnapshot_IsRejected()
    {
        var client = new FakeServiceClient(_ => Task.FromResult<ServiceStateSnapshot>(null!));

        Assert.Equal(ProtocolV1.Errors.InvalidServiceResponse, ErrorCode(await GetStateAsync(client)));
    }

    [Fact]
    public async Task SnapshotAboveChromiumLimit_ReturnsResponseTooLarge()
    {
        var response = await GetStateAsync(FakeServiceClient.Returning(SampleState.WithRules(10000)));

        Assert.Equal(ProtocolV1.Errors.ResponseTooLarge, ErrorCode(response));
    }

    [Fact]
    public async Task SnapshotBelowChromiumLimit_IsForwarded()
    {
        var response = await GetStateAsync(FakeServiceClient.Returning(SampleState.WithRules(3000)));

        Assert.True(response.GetProperty("ok").GetBoolean());
        Assert.Equal(3000, response.GetProperty("result").GetProperty("state").GetProperty("rules").GetArrayLength());
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
    public async Task EachGetState_CallsServiceAgain_NoCaching()
    {
        var client = FakeServiceClient.Returning(SampleState.Snapshot());
        await HostHarness.RunAsync(Frames.Concat(
            Frames.Of(Frames.Request("getState", "c1")), Frames.Of(Frames.Request("getState", "c2"))), client);

        Assert.Equal(2, client.Calls);
    }
}
