using System.Text;
using System.Text.Json;
using VpnRoute.NativeHost.Security;
using VpnRoute.NativeHost.Service;

namespace VpnRoute.NativeHost.Tests.Support;

internal sealed class RecordingLog : IHostLog
{
    public List<string> Lines { get; } = [];

    public void Info(string message) => Lines.Add(message);
}

internal sealed record ServiceCall(string CorrelationId, SnapshotIdentity? Identity, int? StartIndex);

internal sealed class FakeServiceClient(
    Func<CancellationToken, Task<ServiceReply>> manifest,
    Func<SnapshotIdentity, int, CancellationToken, Task<ServiceReply>> page) : IServiceStateClient
{
    public List<ServiceCall> Requests { get; } = [];
    public int Calls => Requests.Count;

    public Task<ServiceReply> GetManifestAsync(string correlationId, ManifestClientInfo? client, CancellationToken cancellationToken)
    {
        Requests.Add(new(correlationId, null, null));
        LastManifestClient = client;
        return manifest(cancellationToken);
    }

    public ManifestClientInfo? LastManifestClient { get; private set; }

    public Task<ServiceReply> GetPageAsync(string correlationId, SnapshotIdentity identity, int startIndex, CancellationToken cancellationToken)
    {
        Requests.Add(new(correlationId, identity, startIndex));
        return page(identity, startIndex, cancellationToken);
    }

    public static FakeServiceClient Returning(ServiceReply manifest, Func<SnapshotIdentity, int, ServiceReply>? page = null) =>
        new(_ => Task.FromResult(manifest), (id, start, _) => Task.FromResult(page is null ? SampleService.PageReply(id, start) : page(id, start)));

    public static FakeServiceClient Throwing(Exception exception) =>
        new(_ => Task.FromException<ServiceReply>(exception), (_, _, _) => Task.FromException<ServiceReply>(exception));

    public static FakeServiceClient Unavailable() => Throwing(new ServiceUnavailableException());

    public static FakeServiceClient Default() => Returning(SampleService.ManifestReply());
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
            input, output, args ?? ChromeArgs, client ?? FakeServiceClient.Unavailable(), log, serviceTimeout);
        var stdout = output.ToArray();
        return new HostRun(exitCode, stdout, Frames.Parse(stdout), log.Lines);
    }
}

/// <summary>Service IPC v1 result payloads as the VPN Route Service produces them.</summary>
internal static class SampleService
{
    public const string Generation = "9b2f6c1e-1d2a-4f57-9a43-3f2a9d7c1b10";
    public const long Revision = 43;

    public static string Manifest(int ruleCount = 1, long revision = Revision, string generation = Generation,
        string proxy = """{"status":"Unavailable","endpoint":null}""") =>
        $$"""{"schemaVersion":1,"stateGeneration":"{{generation}}","revision":{{revision}},"defaultRoute":"Direct","ruleCount":{{ruleCount}},"pageBudgetBytes":520192,"browserProxy":{{proxy}}}""";

    public static ServiceReply ManifestReply(int ruleCount = 1, long revision = Revision, string proxy = """{"status":"Unavailable","endpoint":null}""") =>
        ServiceReply.Success(Encoding.UTF8.GetBytes(Manifest(ruleCount, revision, proxy: proxy)));

    public static string Rule(int i) =>
        $$"""{"id":"rule-{{i:D5}}","name":"Generated rule {{i}}","host":"host-{{i:D5}}.example-domain.test","matchType":"DomainAndSubdomains","routeMode":"VPN","enabled":true,"source":"User","notes":null}""";

    public static string Page(int startIndex, int count, int? nextIndex, long revision = Revision, string generation = Generation) =>
        $$"""{"stateGeneration":"{{generation}}","revision":{{revision}},"startIndex":{{startIndex}},"nextIndex":{{(nextIndex?.ToString() ?? "null")}},"rules":[{{string.Join(",", Enumerable.Range(startIndex, count).Select(Rule))}}]}""";

    public static ServiceReply PageReply(SnapshotIdentity identity, int startIndex, int count = 1, int? nextIndex = null) =>
        ServiceReply.Success(Encoding.UTF8.GetBytes(Page(startIndex, count, nextIndex, identity.Revision, identity.StateGeneration)));

    public static string PageRequest(int startIndex = 0, string requestId = "page-1", string generation = Generation, long revision = Revision) =>
        JsonSerializer.Serialize(new { protocolVersion = 1, requestId, command = "getStatePage", stateGeneration = generation, revision, startIndex });
}
