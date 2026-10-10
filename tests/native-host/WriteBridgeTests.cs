using System.Linq;
using System.Text.Json;
using VpnRoute.NativeHost.Protocol;
using VpnRoute.NativeHost.Service;
using VpnRoute.NativeHost.Tests.Support;

namespace VpnRoute.NativeHost.Tests;

public class WriteBridgeTests
{
    private static async Task<JsonElement> SendAsync(string json, FakeServiceClient client) =>
        Assert.Single((await HostHarness.RunAsync(Frames.Of(json), client)).Responses);

    private static string ErrorCode(JsonElement response) =>
        response.GetProperty("error").GetProperty("code").GetString()!;

    private const string SampleRule =
        """{"id":"rule-1","name":"Example","host":"example.com","matchType":"ExactHost","routeMode":"VPN","enabled":true,"source":"User","notes":null}""";

    private const string MultiHostRule =
        """{"id":"rule-yt","name":"YouTube","host":"youtube.com","hosts":["youtube.com","youtu.be","googlevideo.com"],"matchType":"DomainAndSubdomains","routeMode":"VPN","enabled":false,"source":"User","notes":null}""";

    [Fact]
    public async Task UpsertRule_AcceptsMultiDomainHostsArray()
    {
        string? capturedRuleJson = null;
        var client = FakeServiceClient.WithWrites(SampleService.ManifestReply(), (_, rule) =>
        {
            capturedRuleJson = rule.GetRawText();
            return SampleService.WriteReply(14);
        });
        var response = await SendAsync(
            $$"""{"protocolVersion":1,"requestId":"w-mh","command":"upsertRule","expectedRevision":13,"rule":{{MultiHostRule}}}""", client);

        Assert.True(response.GetProperty("ok").GetBoolean());
        Assert.NotNull(capturedRuleJson);
        using var captured = JsonDocument.Parse(capturedRuleJson!);
        var root = captured.RootElement;
        var hosts = root.GetProperty("hosts");
        Assert.Equal(3, hosts.GetArrayLength());
        Assert.Equal("youtube.com", hosts[0].GetString());
        Assert.Equal("DomainAndSubdomains", root.GetProperty("matchType").GetString());
    }

    [Fact]
    public async Task UpsertRule_RejectsUnknownRuleField()
    {
        var client = FakeServiceClient.WithWrites(SampleService.ManifestReply(), (_, _) => SampleService.WriteReply(2));
        var response = await SendAsync(
            """{"protocolVersion":1,"requestId":"w-bad","command":"upsertRule","expectedRevision":1,"rule":{"id":"rule-1","name":"X","host":"a.com","hosts":["a.com"],"extra":1,"matchType":"ExactHost","routeMode":"VPN","enabled":true,"source":"User","notes":null}}""",
            client);

        Assert.False(response.GetProperty("ok").GetBoolean());
        Assert.Equal(ProtocolV1.Errors.InvalidRequest, ErrorCode(response));
        Assert.Equal(0, client.Calls);
    }

    [Fact]
    public async Task UpsertRule_ForwardsExpectedRevisionAndRulePayload()
    {
        string? capturedRuleId = null;
        var client = FakeServiceClient.WithWrites(SampleService.ManifestReply(), (rev, rule) =>
        {
            capturedRuleId = rule.GetProperty("id").GetString();
            Assert.Equal(12L, rev);
            return SampleService.WriteReply(13);
        });
        var json = $$"""
            {"protocolVersion":1,"requestId":"w-1","command":"upsertRule","expectedRevision":12,"rule":{{SampleRule}}}
            """;
        var response = await SendAsync(json, client);

        Assert.True(response.GetProperty("ok").GetBoolean());
        Assert.Equal(SampleService.WriteResult(13), response.GetProperty("result").GetRawText());
        Assert.Equal("rule-1", capturedRuleId);
        var call = Assert.Single(client.Requests, r => r.WriteMethod == ServiceIpcV1.Methods.UpsertRule);
        Assert.Equal("w-1", call.CorrelationId);
        Assert.Equal(12L, call.ExpectedRevision);
    }

    [Fact]
    public async Task DeleteRule_ForwardsIdAndExpectedRevision()
    {
        string? capturedId = null;
        var client = FakeServiceClient.WithWrites(SampleService.ManifestReply(), delete: (rev, id) =>
        {
            capturedId = id;
            Assert.Equal(4L, rev);
            return SampleService.WriteReply(5);
        });
        var response = await SendAsync(
            """{"protocolVersion":1,"requestId":"d-1","command":"deleteRule","expectedRevision":4,"id":"rule-1"}""", client);

        Assert.True(response.GetProperty("ok").GetBoolean());
        Assert.Equal("rule-1", capturedId);
    }

    [Fact]
    public async Task ResetRules_ForwardsExpectedRevision()
    {
        long? captured = null;
        var client = FakeServiceClient.WithWrites(SampleService.ManifestReply(), reset: rev =>
        {
            captured = rev;
            return SampleService.WriteReply(1, ruleCount: 0);
        });
        var response = await SendAsync(
            """{"protocolVersion":1,"requestId":"r-1","command":"resetRules","expectedRevision":0}""", client);

        Assert.True(response.GetProperty("ok").GetBoolean());
        Assert.Equal(0L, captured);
    }

    [Theory]
    [InlineData("revision_conflict", 44L)]
    [InlineData("validation_failed", null)]
    [InlineData("not_found", null)]
    [InlineData("persistence_failed", null)]
    public async Task ServiceWriteErrors_AreForwarded(string serviceCode, long? currentRevision)
    {
        var client = FakeServiceClient.WithWrites(SampleService.ManifestReply(),
            reset: _ => ServiceReply.Failure(serviceCode, currentRevision));
        var response = await SendAsync(
            $$"""{"protocolVersion":1,"requestId":"e-1","command":"resetRules","expectedRevision":1}""", client);

        Assert.False(response.GetProperty("ok").GetBoolean());
        Assert.Equal(serviceCode, ErrorCode(response));
        var error = response.GetProperty("error");
        Assert.Equal(["code", "message"], Frames.Keys(error).Where(k => k is not "currentRevision").ToArray());
        if (currentRevision is not null)
            Assert.Equal(currentRevision, error.GetProperty("currentRevision").GetInt64());
    }

    [Fact]
    public async Task UnknownNativeWriteCommand_IsRejected()
    {
        var client = FakeServiceClient.Default();
        var response = await SendAsync(
            """{"protocolVersion":1,"requestId":"x","command":"upsertRules","expectedRevision":0,"rule":{}}""", client);

        Assert.Equal(ProtocolV1.Errors.UnknownCommand, ErrorCode(response));
        Assert.Equal(0, client.Calls);
    }

    [Fact]
    public async Task UpsertRule_DoesNotReplayAfterAmbiguousServiceFailure()
    {
        var attempts = 0;
        var client = new FakeServiceClient(
            _ => Task.FromResult(SampleService.ManifestReply()),
            (_, _, _) => Task.FromResult(SampleService.PageReply(new(SampleService.Generation, SampleService.Revision), 0)),
            (_, _, _) =>
            {
                attempts++;
                throw new IOException("connection lost");
            });
        var response = await SendAsync(
            $$"""{"protocolVersion":1,"requestId":"m-1","command":"upsertRule","expectedRevision":1,"rule":{{SampleRule}}}""", client);

        Assert.Equal(ProtocolV1.Errors.ServiceError, ErrorCode(response));
        Assert.Equal(1, attempts);
    }
}
