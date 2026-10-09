using VpnRoute.NativeHost.Protocol;
using VpnRoute.NativeHost.Security;
using VpnRoute.NativeHost.Service;

namespace VpnRoute.NativeHost;

internal static class ExitCodes
{
    public const int CleanEof = 0;
    public const int UnexpectedError = 1;
    public const int MessageTooLarge = 2;
    public const int TruncatedMessage = 3;
    public const int ForbiddenOrigin = 4;
}

/// <summary>Diagnostics sink. Production writes to stderr; stdout carries protocol frames only.</summary>
internal interface IHostLog
{
    void Info(string message);
}

internal sealed class StderrLog : IHostLog
{
    public void Info(string message) => Console.Error.WriteLine($"[native-host] {message}");
}

internal static class NativeHostApp
{
    public static async Task<int> RunAsync(
        Stream input,
        Stream output,
        IReadOnlyList<string> args,
        IServiceStateClient serviceClient,
        IServiceEventsClient eventsClient,
        IHostLog log,
        TimeSpan? serviceTimeout = null,
        CancellationToken cancellationToken = default)
    {
        var writer = new FrameWriter(output);

        var origin = CallerOrigin.Check(args);
        if (origin != OriginCheck.Allowed)
        {
            log.Info($"caller origin rejected: {origin}");
            await writer.WriteAsync(ResponseWriter.Error(null, ProtocolV1.Errors.ForbiddenOrigin), cancellationToken)
                .ConfigureAwait(false);
            return ExitCodes.ForbiddenOrigin;
        }

        log.Info($"started, protocol {ProtocolV1.Version}, version {RequestDispatcher.HostVersion}");
        var reader = new FrameReader(input, ProtocolV1.MaxRequestBytes);
        var dispatcher = new RequestDispatcher(serviceClient, serviceTimeout ?? RequestDispatcher.DefaultServiceTimeout);

        while (true)
        {
            var frame = await reader.ReadAsync(cancellationToken).ConfigureAwait(false);
            switch (frame.Kind)
            {
                case FrameKind.Eof:
                    log.Info("stdin closed");
                    return ExitCodes.CleanEof;

                case FrameKind.TruncatedHeader:
                case FrameKind.TruncatedPayload:
                    log.Info($"truncated frame: {frame.Kind}");
                    return ExitCodes.TruncatedMessage;

                case FrameKind.TooLarge:
                    log.Info($"frame too large: {frame.DeclaredLength} bytes");
                    await writer.WriteAsync(ResponseWriter.Error(null, ProtocolV1.Errors.MessageTooLarge), cancellationToken)
                        .ConfigureAwait(false);
                    return ExitCodes.MessageTooLarge;

                case FrameKind.Empty:
                    log.Info("empty frame");
                    await writer.WriteAsync(ResponseWriter.Error(null, ProtocolV1.Errors.InvalidMessage), cancellationToken)
                        .ConfigureAwait(false);
                    continue;

                case FrameKind.Message:
                    var result = await dispatcher.DispatchAsync(frame.Payload!, cancellationToken).ConfigureAwait(false);
                    log.Info($"request {result.Command}: {result.Outcome}");
                    await writer.WriteAsync(result.Response, cancellationToken).ConfigureAwait(false);
                    if (result.EnterWatchMode)
                    {
                        await ServiceEventsForwarder.ForwardAsync(eventsClient, writer, input, log, cancellationToken)
                            .ConfigureAwait(false);
                    }
                    continue;

                default:
                    throw new InvalidOperationException("Unknown frame kind.");
            }
        }
    }
}
