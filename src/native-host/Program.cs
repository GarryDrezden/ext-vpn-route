using System.Runtime.Versioning;
using VpnRoute.NativeHost;
using VpnRoute.NativeHost.Service;

[assembly: SupportedOSPlatform("windows")]

var stdin = Console.OpenStandardInput();
var stdout = Console.OpenStandardOutput();

// Stray console output must never corrupt the framed stdout channel.
Console.SetOut(Console.Error);

var log = new StderrLog();
var testPipe = Environment.GetEnvironmentVariable(ServiceIpcV1.TestPipeVariable);
var pipeName = ServiceIpcV1.ResolvePipeName(testPipe);
if (!string.IsNullOrEmpty(testPipe))
    log.Info(pipeName is null ? "test service pipe override rejected" : "test service pipe override active");

try
{
    return await NativeHostApp.RunAsync(stdin, stdout, args, new BrowserRoutingPipeClient(pipeName), log);
}
catch (Exception ex)
{
    log.Info($"fatal: {ex.GetType().Name}");
    return ExitCodes.UnexpectedError;
}
