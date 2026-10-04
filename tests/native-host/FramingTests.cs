using System.Text;
using VpnRoute.NativeHost.Protocol;
using VpnRoute.NativeHost.Tests.Support;

namespace VpnRoute.NativeHost.Tests;

public class FramingTests
{
    [Fact]
    public async Task Ping_ReturnsPong()
    {
        var run = await HostHarness.RunAsync(Frames.Of(Frames.Request("ping")));

        Assert.Equal(ExitCodes.CleanEof, run.ExitCode);
        var response = Assert.Single(run.Responses);
        Assert.True(response.GetProperty("ok").GetBoolean());
        Assert.Equal("pong", response.GetProperty("result").GetProperty("command").GetString());
    }

    [Fact]
    public async Task GetStateManifest_WithFakeService_Succeeds()
    {
        var client = FakeServiceClient.Default();
        var run = await HostHarness.RunAsync(Frames.Of(Frames.Request("getStateManifest")), client);

        var response = Assert.Single(run.Responses);
        Assert.True(response.GetProperty("ok").GetBoolean());
        Assert.Equal(43, response.GetProperty("result").GetProperty("revision").GetInt32());
        Assert.Equal(1, client.Calls);
    }

    [Fact]
    public async Task UnknownCommand_ReturnsError_AndHostContinues()
    {
        var run = await HostHarness.RunAsync(Frames.Concat(
            Frames.Of(Frames.Request("deleteEverything", "a1")),
            Frames.Of(Frames.Request("ping", "a2"))));

        Assert.Equal(ExitCodes.CleanEof, run.ExitCode);
        Assert.Equal(2, run.Responses.Count);
        Assert.Equal(ProtocolV1.Errors.UnknownCommand, run.Responses[0].GetProperty("error").GetProperty("code").GetString());
        Assert.Equal("a1", run.Responses[0].GetProperty("requestId").GetString());
        Assert.True(run.Responses[1].GetProperty("ok").GetBoolean());
    }

    [Theory]
    [InlineData("{")]
    [InlineData("not json")]
    [InlineData("{\"protocolVersion\":1,}")]
    [InlineData("{\"protocolVersion\":1 /* c */}")]
    public async Task MalformedJson_ReturnsMalformedJson(string payload)
    {
        var run = await HostHarness.RunAsync(Frames.Of(payload));

        var response = Assert.Single(run.Responses);
        Assert.False(response.GetProperty("ok").GetBoolean());
        Assert.Equal(ProtocolV1.Errors.MalformedJson, response.GetProperty("error").GetProperty("code").GetString());
        Assert.Equal(System.Text.Json.JsonValueKind.Null, response.GetProperty("requestId").ValueKind);
    }

    [Fact]
    public async Task InvalidUtf8_ReturnsMalformedJson()
    {
        var run = await HostHarness.RunAsync(Frames.Raw([0x22, 0xC3, 0x28, 0x22]));

        Assert.Equal(ProtocolV1.Errors.MalformedJson, Assert.Single(run.Responses).GetProperty("error").GetProperty("code").GetString());
    }

    [Fact]
    public async Task InvalidUtf8InsideRequestId_ReturnsMalformedJson()
    {
        var payload = Frames.Concat(
            Encoding.UTF8.GetBytes("{\"protocolVersion\":1,\"requestId\":\"a"),
            [0xC3, 0x28],
            Encoding.UTF8.GetBytes("\",\"command\":\"ping\"}"));
        var run = await HostHarness.RunAsync(Frames.Raw(payload));

        Assert.Equal(ExitCodes.CleanEof, run.ExitCode);
        Assert.Equal(ProtocolV1.Errors.MalformedJson, Assert.Single(run.Responses).GetProperty("error").GetProperty("code").GetString());
    }

    [Theory]
    [InlineData(0)]
    [InlineData(2)]
    [InlineData(-1)]
    public async Task UnsupportedProtocolVersion_IsRejected(int version)
    {
        var run = await HostHarness.RunAsync(Frames.Of(Frames.Request("ping", "v1", version)));

        var response = Assert.Single(run.Responses);
        Assert.Equal(ProtocolV1.Errors.UnsupportedProtocolVersion, response.GetProperty("error").GetProperty("code").GetString());
        Assert.Equal("v1", response.GetProperty("requestId").GetString());
    }

    [Fact]
    public async Task OversizedFrame_IsRejectedBeforeReadingPayload()
    {
        var run = await HostHarness.RunAsync(Frames.Header(ProtocolV1.MaxRequestBytes + 1));

        Assert.Equal(ExitCodes.MessageTooLarge, run.ExitCode);
        Assert.Equal(ProtocolV1.Errors.MessageTooLarge, Assert.Single(run.Responses).GetProperty("error").GetProperty("code").GetString());
    }

    [Fact]
    public async Task HugeDeclaredLength_IsRejected()
    {
        var run = await HostHarness.RunAsync(Frames.Header(uint.MaxValue));

        Assert.Equal(ExitCodes.MessageTooLarge, run.ExitCode);
    }

    [Theory]
    [InlineData(1)]
    [InlineData(3)]
    public async Task TruncatedHeader_ExitsWithoutResponse(int headerBytes)
    {
        var run = await HostHarness.RunAsync(Frames.Header(10).Take(headerBytes).ToArray());

        Assert.Equal(ExitCodes.TruncatedMessage, run.ExitCode);
        Assert.Empty(run.Stdout);
    }

    [Fact]
    public async Task TruncatedPayload_ExitsWithoutResponse()
    {
        var full = Frames.Of(Frames.Request("ping"));
        var run = await HostHarness.RunAsync(full.Take(full.Length - 5).ToArray());

        Assert.Equal(ExitCodes.TruncatedMessage, run.ExitCode);
        Assert.Empty(run.Stdout);
    }

    [Fact]
    public async Task EmptyFrame_ReturnsInvalidMessage_AndHostContinues()
    {
        var run = await HostHarness.RunAsync(Frames.Concat(Frames.Header(0), Frames.Of(Frames.Request("ping"))));

        Assert.Equal(ExitCodes.CleanEof, run.ExitCode);
        Assert.Equal(ProtocolV1.Errors.InvalidMessage, run.Responses[0].GetProperty("error").GetProperty("code").GetString());
        Assert.True(run.Responses[1].GetProperty("ok").GetBoolean());
    }

    [Fact]
    public async Task SequentialMessages_AreAnsweredInOrder()
    {
        var client = FakeServiceClient.Default();
        var run = await HostHarness.RunAsync(Frames.Concat(
            Frames.Of(Frames.Request("ping", "s1")),
            Frames.Of(Frames.Request("getStateManifest", "s2")),
            Frames.Of("{"),
            Frames.Of(Frames.Request("ping", "s4"))), client);

        Assert.Equal(ExitCodes.CleanEof, run.ExitCode);
        Assert.Equal(4, run.Responses.Count);
        Assert.Equal("s1", run.Responses[0].GetProperty("requestId").GetString());
        Assert.Equal("s2", run.Responses[1].GetProperty("requestId").GetString());
        Assert.False(run.Responses[2].GetProperty("ok").GetBoolean());
        Assert.Equal("s4", run.Responses[3].GetProperty("requestId").GetString());
    }

    [Fact]
    public async Task CleanEof_WithoutMessages_ExitsZero()
    {
        var run = await HostHarness.RunAsync([]);

        Assert.Equal(ExitCodes.CleanEof, run.ExitCode);
        Assert.Empty(run.Stdout);
    }

    [Fact]
    public async Task Stdout_ContainsOnlyFrames_AndLogsGoToLogSink()
    {
        var run = await HostHarness.RunAsync(Frames.Concat(
            Frames.Of(Frames.Request("ping")), Frames.Of("garbage"), Frames.Of(Frames.Request("getStateManifest"))));

        Assert.Equal(3, run.Responses.Count);
        Assert.NotEmpty(run.Log);
        Assert.DoesNotContain("[native-host]", Encoding.UTF8.GetString(run.Stdout), StringComparison.Ordinal);
    }

    [Fact]
    public async Task RequestAtSizeLimit_IsParsed()
    {
        var padding = new string(' ', ProtocolV1.MaxRequestBytes - Encoding.UTF8.GetByteCount(Frames.Request("ping")));
        var run = await HostHarness.RunAsync(Frames.Of(Frames.Request("ping") + padding));

        Assert.True(Assert.Single(run.Responses).GetProperty("ok").GetBoolean());
    }
}
