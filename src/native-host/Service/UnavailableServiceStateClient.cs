namespace VpnRoute.NativeHost.Service;

/// <summary>
/// Production client until the VPN Route Service connector exists. It opens no pipe, socket,
/// file or registry key and always reports the Service as unavailable.
/// </summary>
public sealed class UnavailableServiceStateClient : IServiceStateClient
{
    public Task<ServiceStateSnapshot> GetStateAsync(CancellationToken cancellationToken) =>
        Task.FromException<ServiceStateSnapshot>(new ServiceUnavailableException());
}
