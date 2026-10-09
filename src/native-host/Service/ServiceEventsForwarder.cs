using VpnRoute.NativeHost.Protocol;

namespace VpnRoute.NativeHost.Service;

internal static class ServiceEventsForwarder
{
    private static readonly HashSet<string> KnownTypes = new(StringComparer.Ordinal)
    {
        ServiceIpcV1.EventTypes.BrowserRoutingChanged,
        ServiceIpcV1.EventTypes.ServiceAvailable
    };

    public static async Task ForwardAsync(
        IServiceEventsClient eventsClient,
        FrameWriter writer,
        Stream stdin,
        IHostLog log,
        CancellationToken cancellationToken)
    {
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        _ = Task.Run(async () =>
        {
            try
            {
                var reader = new FrameReader(stdin, ProtocolV1.MaxRequestBytes);
                while (await reader.ReadAsync(linked.Token).ConfigureAwait(false) is { Kind: not FrameKind.Eof })
                {
                }
            }
            catch (OperationCanceledException)
            {
            }
            finally
            {
                await linked.CancelAsync().ConfigureAwait(false);
            }
        }, CancellationToken.None);

        try
        {
            await foreach (var evt in eventsClient.SubscribeAsync(linked.Token).ConfigureAwait(false))
            {
                if (!KnownTypes.Contains(evt.Type))
                    continue;
                if (!RequestDispatcher.IsGeneration(evt.StateGeneration))
                    continue;
                if (evt.Revision < 0 || evt.Revision > ProtocolV1.MaxRevision)
                    continue;

                var frame = ResponseWriter.Success(requestId: null!, w =>
                {
                    w.WriteStartObject();
                    w.WriteString("type", evt.Type);
                    w.WriteString("stateGeneration", evt.StateGeneration);
                    w.WriteNumber("revision", evt.Revision);
                    w.WriteEndObject();
                });
                await writer.WriteAsync(frame, linked.Token).ConfigureAwait(false);
            }
        }
        catch (OperationCanceledException) when (linked.Token.IsCancellationRequested)
        {
            log.Info("watchEvents session ended");
        }
    }
}
