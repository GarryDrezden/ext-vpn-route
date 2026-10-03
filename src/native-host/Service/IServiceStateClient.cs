using System.Text.Json;

namespace VpnRoute.NativeHost.Service;

/// <summary>Loopback proxy endpoint published by VPN Route Service.</summary>
public sealed record ProxyEndpoint(string Host, int Port);

/// <summary>
/// One state snapshot from VPN Route Service. The host forwards <see cref="State"/> verbatim:
/// the Service owns BrowserRoutingStateV1, the extension validates it.
/// </summary>
public sealed record ServiceStateSnapshot(JsonElement State, ProxyEndpoint ProxyEndpoint);

/// <summary>Source of browser routing state. The native host never stores or produces state itself.</summary>
public interface IServiceStateClient
{
    Task<ServiceStateSnapshot> GetStateAsync(CancellationToken cancellationToken);
}

/// <summary>VPN Route Service is not running or not reachable.</summary>
public sealed class ServiceUnavailableException : Exception
{
    public ServiceUnavailableException() : base("VPN Route Service is unavailable.") { }

    public ServiceUnavailableException(string message) : base(message) { }

    public ServiceUnavailableException(string message, Exception innerException) : base(message, innerException) { }
}
