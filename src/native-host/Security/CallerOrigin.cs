namespace VpnRoute.NativeHost.Security;

internal enum OriginCheck
{
    Allowed,
    Missing,
    Mismatch,
    UnexpectedArguments
}

/// <summary>
/// Chromium on Windows starts the host as <c>host.exe chrome-extension://&lt;id&gt;/ --parent-window=&lt;hwnd&gt;</c>.
/// The registry manifest already restricts allowed_origins; this is the host-side second check.
/// </summary>
internal static class CallerOrigin
{
    public const string ProductionExtensionId = "lfaekfalhkgmbfdjjlfcalanhijeaien";
    public const string AllowedOrigin = "chrome-extension://" + ProductionExtensionId + "/";

    private const string ParentWindowPrefix = "--parent-window=";

    public static OriginCheck Check(IReadOnlyList<string> args)
    {
        if (args.Count == 0 || string.IsNullOrEmpty(args[0]))
            return OriginCheck.Missing;
        if (!string.Equals(args[0], AllowedOrigin, StringComparison.Ordinal))
            return OriginCheck.Mismatch;

        for (var i = 1; i < args.Count; i++)
        {
            if (!IsParentWindowArgument(args[i]))
                return OriginCheck.UnexpectedArguments;
        }
        return OriginCheck.Allowed;
    }

    private static bool IsParentWindowArgument(string arg)
    {
        if (!arg.StartsWith(ParentWindowPrefix, StringComparison.Ordinal))
            return false;
        var value = arg.AsSpan(ParentWindowPrefix.Length);
        if (value.Length is 0 or > 20)
            return false;
        foreach (var c in value)
        {
            if (c is < '0' or > '9')
                return false;
        }
        return true;
    }
}
