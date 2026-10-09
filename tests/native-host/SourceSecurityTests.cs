using System.Text.RegularExpressions;

namespace VpnRoute.NativeHost.Tests;

/// <summary>Static guard rails over the production host sources.</summary>
public class SourceSecurityTests
{
    private static string RepositoryRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !File.Exists(Path.Combine(dir.FullName, "package.json")))
            dir = dir.Parent;
        Assert.NotNull(dir);
        return dir!.FullName;
    }

    private static string HostDirectory => Path.Combine(RepositoryRoot(), "src", "native-host");

    private static IEnumerable<string> HostSources() =>
        Directory.EnumerateFiles(HostDirectory, "*.cs", SearchOption.AllDirectories)
            .Where(path => !path.Contains($"{Path.DirectorySeparatorChar}bin{Path.DirectorySeparatorChar}", StringComparison.Ordinal)
                && !path.Contains($"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}", StringComparison.Ordinal));

    public static TheoryData<string, string> ForbiddenApis => new()
    {
        { "network listener", @"\b(TcpListener|HttpListener|UdpClient|Socket|WebSocket|HttpClient|Kestrel)\b" },
        { "network namespace", @"System\.Net\.(Sockets|Http|WebSockets)" },
        { "pipe server", @"NamedPipeServerStream|AnonymousPipe|RunAsClient" },
        { "impersonation", @"TokenImpersonationLevel\.(Impersonation|Delegation|Anonymous)" },
        { "process launch", @"\bProcess\b|ProcessStartInfo|cmd\.exe|powershell|pwsh" },
        { "file system", @"\b(File|Directory|FileStream|FileInfo|DirectoryInfo|StreamReader|StreamWriter)\b\s*[.(]" },
        { "registry", @"\bRegistry\b|Microsoft\.Win32" },
        { "environment state", @"Environment\.(GetEnvironmentVariables|GetCommandLineArgs|ExpandEnvironmentVariables|SetEnvironmentVariable)|Environment\.GetEnvironmentVariable\((?!ServiceIpcV1\.TestPipeVariable\))" },
        { "reflection loading", @"Assembly\.Load|Activator\.CreateInstance|Type\.GetType|DllImport|LibraryImport" },
        { "persistence", @"IsolatedStorage|MemoryCache|static\s+(?!readonly)[\w<>,\[\]? ]+\s+_?state" }
    };

    [Theory]
    [MemberData(nameof(ForbiddenApis))]
    public void HostSources_DoNotUse(string label, string pattern)
    {
        var regex = new Regex(pattern, RegexOptions.CultureInvariant);
        var sources = HostSources().ToList();
        Assert.NotEmpty(sources);
        foreach (var path in sources)
        {
            var text = File.ReadAllText(path);
            var match = regex.Match(text);
            Assert.False(match.Success, $"{label}: '{match.Value}' in {Path.GetFileName(path)}");
        }
    }

    [Fact]
    public void OnlyThePipeClient_UsesPipes_WithIdentificationLevel()
    {
        foreach (var path in HostSources())
        {
            var text = File.ReadAllText(path);
            var isClient = Path.GetFileName(path) == "BrowserRoutingPipeClient.cs";
            Assert.Equal(isClient, text.Contains("NamedPipeClientStream", StringComparison.Ordinal));
            Assert.Equal(isClient, text.Contains("System.IO.Pipes", StringComparison.Ordinal));
            if (isClient)
                Assert.Contains("TokenImpersonationLevel.Identification", text, StringComparison.Ordinal);
        }
    }

    [Fact]
    public void ServiceSurface_IsTheFixedReadOnlyAllowlist()
    {
        var methods = typeof(VpnRoute.NativeHost.Service.IServiceStateClient).GetMethods().Select(m => m.Name).Order().ToArray();
        Assert.Equal(["DeleteRuleAsync", "GetManifestAsync", "GetPageAsync", "ResetRulesAsync", "UpsertRuleAsync"], methods);

        var serviceMethods = typeof(VpnRoute.NativeHost.Service.ServiceIpcV1.Methods).GetFields().Select(f => (string)f.GetValue(null)!).Order();
        Assert.Equal(["deleteRule", "getManifest", "getPage", "resetRules", "upsertRule"], serviceMethods);

        var commands = typeof(VpnRoute.NativeHost.Protocol.ProtocolV1.Commands).GetFields().Select(f => (string)f.GetValue(null)!).Order();
        Assert.Equal(["deleteRule", "getStateManifest", "getStatePage", "ping", "resetRules", "upsertRule"], commands);

        Assert.Equal("SelectiveVpnRouter.BrowserRouting", VpnRoute.NativeHost.Service.ServiceIpcV1.PipeName);
        var client = File.ReadAllText(Path.Combine(HostDirectory, "Service", "BrowserRoutingPipeClient.cs"));
        Assert.DoesNotMatch(@"""SelectiveVpnRouter""", client);
    }

    [Fact]
    public void OnlyProgram_ReadsTheTestPipeVariable_AndResolvesIt()
    {
        foreach (var path in HostSources())
        {
            var text = File.ReadAllText(path);
            var isProgram = Path.GetFileName(path) == "Program.cs";
            Assert.Equal(isProgram, text.Contains("GetEnvironmentVariable", StringComparison.Ordinal));
            if (isProgram)
            {
                Assert.Single(Regex.Matches(text, "GetEnvironmentVariable"));
                Assert.Contains("ServiceIpcV1.ResolvePipeName(testPipe)", text, StringComparison.Ordinal);
                Assert.Contains("new BrowserRoutingPipeClient(pipeName)", text, StringComparison.Ordinal);
            }
        }
        Assert.Equal("VPN_ROUTE_TEST_SERVICE_PIPE", VpnRoute.NativeHost.Service.ServiceIpcV1.TestPipeVariable);
    }

    [Fact]
    public void HostProject_HasNoPackageReferences()
    {
        var csproj = File.ReadAllText(Path.Combine(HostDirectory, "SelectiveVpnRouter.NativeHost.csproj"));

        Assert.DoesNotContain("PackageReference", csproj, StringComparison.Ordinal);
        Assert.DoesNotContain("ProjectReference", csproj, StringComparison.Ordinal);
    }

    [Fact]
    public void OnlyFrameWriterTouchesStdout()
    {
        foreach (var path in HostSources())
        {
            var text = File.ReadAllText(path);
            Assert.False(Regex.IsMatch(text, @"Console\.(Write|WriteLine|Out)\b"), $"Console stdout use in {Path.GetFileName(path)}");
            if (Path.GetFileName(path) != "Program.cs")
                Assert.DoesNotContain("OpenStandardOutput", text, StringComparison.Ordinal);
        }
    }

    [Fact]
    public void HostDoesNotReferenceSpike()
    {
        foreach (var path in HostSources().Append(Path.Combine(HostDirectory, "SelectiveVpnRouter.NativeHost.csproj")))
        {
            var text = File.ReadAllText(path);
            Assert.DoesNotContain("Phase0B", text, StringComparison.Ordinal);
            Assert.DoesNotContain("spike", text, StringComparison.OrdinalIgnoreCase);
        }
    }
}
