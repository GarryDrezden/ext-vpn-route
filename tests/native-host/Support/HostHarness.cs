using System.Text.Json;
using VpnRoute.NativeHost.Security;
using VpnRoute.NativeHost.Service;

namespace VpnRoute.NativeHost.Tests.Support;

internal sealed class RecordingLog : IHostLog
{
    public List<string> Lines { get; } = [];

    public void Info(string message) => Lines.Add(message);
}

internal sealed class FakeServiceClient(Func<CancellationToken, Task<ServiceStateSnapshot>> handler) : IServiceStateClient
{
    public int Calls { get; private set; }

    public Task<ServiceStateSnapshot> GetStateAsync(CancellationToken cancellationToken)
    {
        Calls++;
        return handler(cancellationToken);
    }

    public static FakeServiceClient Returning(ServiceStateSnapshot snapshot) => new(_ => Task.FromResult(snapshot));

    public static FakeServiceClient Throwing(Exception exception) => new(_ => Task.FromException<ServiceStateSnapshot>(exception));
}

internal sealed record HostRun(int ExitCode, byte[] Stdout, List<JsonElement> Responses, List<string> Log);

internal static class HostHarness
{
    public static readonly string[] ChromeArgs = [CallerOrigin.AllowedOrigin, "--parent-window=0"];

    public static async Task<HostRun> RunAsync(
        byte[] stdin,
        IServiceStateClient? client = null,
        string[]? args = null,
        TimeSpan? serviceTimeout = null)
    {
        using var input = new MemoryStream(stdin);
        using var output = new MemoryStream();
        var log = new RecordingLog();
        var exitCode = await NativeHostApp.RunAsync(
            input, output, args ?? ChromeArgs, client ?? new UnavailableServiceStateClient(), log, serviceTimeout);
        var stdout = output.ToArray();
        return new HostRun(exitCode, stdout, Frames.Parse(stdout), log.Lines);
    }
}

internal static class SampleState
{
    public const string Json = """
        {
          "schemaVersion": 1,
          "revision": 43,
          "defaultRoute": "Direct",
          "rules": [
            {
              "id": "youtube",
              "name": "YouTube",
              "host": "youtube.com",
              "matchType": "DomainAndSubdomains",
              "routeMode": "VPN",
              "enabled": true,
              "source": "User",
              "notes": null
            }
          ]
        }
        """;

    public static JsonElement Element(string json = Json)
    {
        using var document = JsonDocument.Parse(json);
        return document.RootElement.Clone();
    }

    public static ServiceStateSnapshot Snapshot(string host = "127.0.0.1", int port = 17891) =>
        new(Element(), new ProxyEndpoint(host, port));

    public static ServiceStateSnapshot WithRules(int count)
    {
        var rules = Enumerable.Range(0, count).Select(i => new
        {
            id = $"rule-{i:D5}",
            name = $"Generated rule {i}",
            host = $"host-{i:D5}.example-domain.test",
            matchType = i % 3 == 0 ? "ExactHost" : "DomainAndSubdomains",
            routeMode = "VPN",
            enabled = true,
            source = "User",
            notes = (string?)null
        });
        var json = JsonSerializer.Serialize(new { schemaVersion = 1, revision = 3999, defaultRoute = "Direct", rules });
        return new ServiceStateSnapshot(Element(json), new ProxyEndpoint("127.0.0.1", 17891));
    }
}
