using VpnRoute.NativeHost;
using VpnRoute.NativeHost.Service;

var stdin = Console.OpenStandardInput();
var stdout = Console.OpenStandardOutput();

// Stray console output must never corrupt the framed stdout channel.
Console.SetOut(Console.Error);

var log = new StderrLog();
try
{
    return await NativeHostApp.RunAsync(stdin, stdout, args, new UnavailableServiceStateClient(), log);
}
catch (Exception ex)
{
    log.Info($"fatal: {ex.GetType().Name}");
    return ExitCodes.UnexpectedError;
}
