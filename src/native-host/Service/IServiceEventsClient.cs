namespace VpnRoute.NativeHost.Service;

internal readonly record struct ServicePushEvent(string Type, string StateGeneration, long Revision);

internal interface IServiceEventsClient
{
    IAsyncEnumerable<ServicePushEvent> SubscribeAsync(CancellationToken cancellationToken);
}
