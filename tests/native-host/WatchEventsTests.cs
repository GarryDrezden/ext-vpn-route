using System.Text.Json;
using VpnRoute.NativeHost.Protocol;
using VpnRoute.NativeHost.Service;
using VpnRoute.NativeHost.Tests.Support;

namespace VpnRoute.NativeHost.Tests;

public class WatchEventsTests
{
    private static async Task<IReadOnlyList<JsonElement>> RunWatchAsync(
        IServiceEventsClient eventsClient,
        CancellationToken cancellationToken = default)
    {
        using var input = new MemoryStream();
        using var output = new MemoryStream();
        var log = new RecordingLog();
        using var stop = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        stop.CancelAfter(TimeSpan.FromSeconds(2));
        var runTask = NativeHostApp.RunAsync(
            input,
            output,
            HostHarness.ChromeArgs,
            FakeServiceClient.Unavailable(),
            eventsClient,
            log,
            null,
            stop.Token);
        await Task.Delay(100, stop.Token);
        await stop.CancelAsync();
        try { await runTask; } catch (OperationCanceledException) { }
        return Frames.Parse(output.ToArray());
    }

    [Fact]
    public async Task WatchEvents_forwards_service_push_payload()
    {
        var gen = SampleService.Generation;
        var events = new FakeEventsClient([
            new ServicePushEvent(ServiceIpcV1.EventTypes.ServiceAvailable, gen, 43),
            new ServicePushEvent(ServiceIpcV1.EventTypes.BrowserRoutingChanged, gen, 44)
        ]);
        using var stopInput = new CancellationTokenSource(TimeSpan.FromSeconds(2));
        using var input = new BlockingInputStream(Frames.Of(Frames.Request(ProtocolV1.Commands.WatchEvents, "watch-1")), stopInput.Token);
        using var output = new MemoryStream();
        var log = new RecordingLog();
        using var stop = new CancellationTokenSource(TimeSpan.FromSeconds(2));
        var runTask = NativeHostApp.RunAsync(
            input, output, HostHarness.ChromeArgs, FakeServiceClient.Unavailable(), events, log, null, stop.Token);
        await Task.Delay(300);
        await stopInput.CancelAsync();
        await stop.CancelAsync();
        try { await runTask; } catch (OperationCanceledException) { }

        var responses = Frames.Parse(output.ToArray());
        Assert.True(responses[0].GetProperty("ok").GetBoolean());
        Assert.Equal("watch-1", responses[0].GetProperty("requestId").GetString());
        var push = responses[1].GetProperty("result");
        Assert.Equal(["type", "stateGeneration", "revision"], Frames.Keys(push));
        Assert.Equal(ServiceIpcV1.EventTypes.ServiceAvailable, push.GetProperty("type").GetString());
        Assert.Equal(gen, push.GetProperty("stateGeneration").GetString());
        Assert.Equal(43, push.GetProperty("revision").GetInt64());
        var changed = responses[2].GetProperty("result");
        Assert.Equal(ServiceIpcV1.EventTypes.BrowserRoutingChanged, changed.GetProperty("type").GetString());
    }

    [Fact]
    public async Task WatchEvents_ignores_unknown_event_type()
    {
        var gen = SampleService.Generation;
        var events = new FakeEventsClient([
            new ServicePushEvent("routingChanged", gen, 1),
            new ServicePushEvent(ServiceIpcV1.EventTypes.ServiceAvailable, gen, 43)
        ]);
        using var stopInput = new CancellationTokenSource(TimeSpan.FromSeconds(2));
        using var input = new BlockingInputStream(Frames.Of(Frames.Request(ProtocolV1.Commands.WatchEvents, "watch-2")), stopInput.Token);
        using var output = new MemoryStream();
        using var stop = new CancellationTokenSource(TimeSpan.FromSeconds(2));
        var runTask = NativeHostApp.RunAsync(
            input, output, HostHarness.ChromeArgs, FakeServiceClient.Unavailable(), events, new RecordingLog(), null, stop.Token);
        await Task.Delay(300);
        await stopInput.CancelAsync();
        await stop.CancelAsync();
        try { await runTask; } catch (OperationCanceledException) { }

        var responses = Frames.Parse(output.ToArray());
        Assert.Equal(2, responses.Count);
        Assert.Equal(ServiceIpcV1.EventTypes.ServiceAvailable, responses[1].GetProperty("result").GetProperty("type").GetString());
    }

    [Fact]
    public void TryParseEvent_rejects_extra_fields()
    {
        var json = """{"type":"serviceAvailable","stateGeneration":"9b2f6c1e-1d2a-4f57-9a43-3f2a9d7c1b10","revision":1,"extra":true}""";
        Assert.False(BrowserRoutingEventsPipeClient.TryParseEvent(System.Text.Encoding.UTF8.GetBytes(json), out _));
    }

    [Fact]
    public async Task WatchEvents_reconnects_after_events_client_disconnect()
    {
        var gen = SampleService.Generation;
        var first = true;
        var events = new ReconnectingEventsClient(() =>
        {
            if (!first) return [];
            first = false;
            return [new ServicePushEvent(ServiceIpcV1.EventTypes.ServiceAvailable, gen, 1)];
        });
        using var stopInput = new CancellationTokenSource(TimeSpan.FromSeconds(2));
        using var input = new BlockingInputStream(Frames.Of(Frames.Request(ProtocolV1.Commands.WatchEvents, "watch-3")), stopInput.Token);
        using var output = new MemoryStream();
        using var stop = new CancellationTokenSource(TimeSpan.FromSeconds(2));
        var runTask = NativeHostApp.RunAsync(
            input, output, HostHarness.ChromeArgs, FakeServiceClient.Unavailable(), events, new RecordingLog(), null, stop.Token);
        await Task.Delay(400);
        await stopInput.CancelAsync();
        await stop.CancelAsync();
        try { await runTask; } catch (OperationCanceledException) { }
        Assert.True(Frames.Parse(output.ToArray()).Count >= 2);
    }

    private sealed class ReconnectingEventsClient(Func<IReadOnlyList<ServicePushEvent>> batch) : IServiceEventsClient
    {
        public async IAsyncEnumerable<ServicePushEvent> SubscribeAsync(
            [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken cancellationToken)
        {
            while (!cancellationToken.IsCancellationRequested)
            {
                foreach (var evt in batch())
                    yield return evt;
                yield break;
            }
        }
    }
}
