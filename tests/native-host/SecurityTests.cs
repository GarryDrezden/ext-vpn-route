using VpnRoute.NativeHost.Protocol;
using VpnRoute.NativeHost.Security;
using VpnRoute.NativeHost.Tests.Support;

namespace VpnRoute.NativeHost.Tests;

public class SecurityTests
{
    [Fact]
    public void AllowedOrigin_IsExactProductionExtension()
    {
        Assert.Equal("chrome-extension://lfaekfalhkgmbfdjjlfcalanhijeaien/", CallerOrigin.AllowedOrigin);
        Assert.DoesNotContain('*', CallerOrigin.AllowedOrigin);
    }

    internal static string[] Args(string joined) => joined.Length == 0 ? [] : joined.Split('|');

    [Theory]
    [InlineData("chrome-extension://lfaekfalhkgmbfdjjlfcalanhijeaien/")]
    [InlineData("chrome-extension://lfaekfalhkgmbfdjjlfcalanhijeaien/|--parent-window=0")]
    [InlineData("chrome-extension://lfaekfalhkgmbfdjjlfcalanhijeaien/|--parent-window=1180734")]
    public void Check_AcceptsChromiumArguments(string args) =>
        Assert.Equal(OriginCheck.Allowed, CallerOrigin.Check(Args(args)));

    [Theory]
    [InlineData("", "Missing")]
    [InlineData("|", "Missing")]
    [InlineData("chrome-extension://onodojebmdbcndjelgfhoiffeojngmbd/", "Mismatch")]
    [InlineData("chrome-extension://lfaekfalhkgmbfdjjlfcalanhijeaien", "Mismatch")]
    [InlineData("chrome-extension://LFAEKFALHKGMBFDJJLFCALANHIJEAIEN/", "Mismatch")]
    [InlineData("chrome-extension://*/", "Mismatch")]
    [InlineData("chrome-extension://lfaekfalhkgmbfdjjlfcalanhijeaien/ ", "Mismatch")]
    [InlineData("--parent-window=0|chrome-extension://lfaekfalhkgmbfdjjlfcalanhijeaien/", "Mismatch")]
    [InlineData("chrome-extension://lfaekfalhkgmbfdjjlfcalanhijeaien/|--parent-window=abc", "UnexpectedArguments")]
    [InlineData("chrome-extension://lfaekfalhkgmbfdjjlfcalanhijeaien/|--parent-window=", "UnexpectedArguments")]
    [InlineData("chrome-extension://lfaekfalhkgmbfdjjlfcalanhijeaien/|--state=foo.json", "UnexpectedArguments")]
    public void Check_RejectsWrongOrMissingOrigin(string args, string expected) =>
        Assert.Equal(Enum.Parse<OriginCheck>(expected), CallerOrigin.Check(Args(args)));

    [Theory]
    [InlineData("")]
    [InlineData("chrome-extension://onodojebmdbcndjelgfhoiffeojngmbd/")]
    public async Task ForbiddenOrigin_ExecutesNoCommands(string args)
    {
        var client = FakeServiceClient.Default();
        var run = await HostHarness.RunAsync(
            Frames.Concat(Frames.Of(Frames.Request("getStateManifest")), Frames.Of(SampleService.PageRequest()), Frames.Of(Frames.Request("ping"))), client, Args(args));

        Assert.Equal(ExitCodes.ForbiddenOrigin, run.ExitCode);
        var response = Assert.Single(run.Responses);
        Assert.False(response.GetProperty("ok").GetBoolean());
        Assert.Equal(ProtocolV1.Errors.ForbiddenOrigin, response.GetProperty("error").GetProperty("code").GetString());
        Assert.Equal(0, client.Calls);
    }

    [Fact]
    public async Task ForbiddenOrigin_DoesNotLogTheRejectedValue()
    {
        var run = await HostHarness.RunAsync([], args: ["chrome-extension://attackerextensionidxxxxxxxxxxxxxx/"]);

        Assert.DoesNotContain(run.Log, line => line.Contains("attacker", StringComparison.Ordinal));
    }

    [Theory]
    [InlineData("exec")]
    [InlineData("shell")]
    [InlineData("readFile")]
    [InlineData("setState")]
    [InlineData("upsertRule")]
    [InlineData("deleteRule")]
    [InlineData("PING")]
    [InlineData("getstate")]
    [InlineData("getState")]
    [InlineData("GetStateManifest")]
    [InlineData("getManifest")]
    [InlineData("getPage")]
    [InlineData("SetConfig")]
    [InlineData("ConnectVpn")]
    [InlineData("EmergencyRestore")]
    [InlineData("relay")]
    public async Task ArbitraryCommands_AreUnavailable(string command)
    {
        var client = FakeServiceClient.Default();
        var run = await HostHarness.RunAsync(Frames.Of(Frames.Request(command)), client);

        Assert.Equal(ProtocolV1.Errors.UnknownCommand, Assert.Single(run.Responses).GetProperty("error").GetProperty("code").GetString());
        Assert.Equal(0, client.Calls);
    }

    [Fact]
    public async Task UnknownCommandName_IsNotReflected()
    {
        var run = await HostHarness.RunAsync(Frames.Of(Frames.Request("evil_command_marker")));

        var text = Assert.Single(run.Responses).GetRawText();
        Assert.DoesNotContain("evil_command_marker", text, StringComparison.Ordinal);
        Assert.DoesNotContain(run.Log, line => line.Contains("evil_command_marker", StringComparison.Ordinal));
    }
}
