namespace VpnRoute.NativeHost.Service;

/// <summary>Identity of one authoritative state version: lineage (generation) plus revision inside it.</summary>
internal sealed record SnapshotIdentity(string StateGeneration, long Revision);

/// <summary>
/// One Service IPC answer: the raw UTF-8 JSON of <c>result</c> (forwarded byte for byte),
/// or a Service error code.
/// </summary>
internal sealed record ServiceReply(byte[]? Result, string? ErrorCode)
{
    public static ServiceReply Success(byte[] result) => new(result, null);
    public static ServiceReply Failure(string code) => new(null, code);
}

/// <summary>
/// The only Service operations the native host can reach: read the state manifest and read one page.
/// There is deliberately no generic "send command" method.
/// </summary>
internal interface IServiceStateClient
{
    Task<ServiceReply> GetManifestAsync(string correlationId, ManifestClientInfo? client, CancellationToken cancellationToken);

    Task<ServiceReply> GetPageAsync(string correlationId, SnapshotIdentity identity, int startIndex, CancellationToken cancellationToken);
}

/// <summary>The Service endpoint does not exist or refused the connection.</summary>
internal sealed class ServiceUnavailableException : Exception
{
    public ServiceUnavailableException() : base("VPN Route Service is unavailable.") { }
}

/// <summary>A pipe with the Service name exists but is owned by an untrusted account (possible squatting).</summary>
internal sealed class ServiceUntrustedException : Exception
{
    public ServiceUntrustedException() : base("VPN Route Service endpoint is not trusted.") { }
}

/// <summary>The Service answered with bytes that are not a valid IPC v1 response.</summary>
internal sealed class InvalidServiceResponseException : Exception
{
    public InvalidServiceResponseException() : base("VPN Route Service response is invalid.") { }
}
